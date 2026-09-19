import type { Pool } from 'pg';
import {
  SCRIPT_HOOKS,
  SchemaError,
  type EngineScriptConfig,
  type Locale,
  type ObjectRegistry,
  type ScriptDispatchArgs,
  type ScriptDispatchResult,
  type ScriptDispatcher,
  type ScriptHook,
  type ScriptServices,
} from '../../core/index.js';
import { PAGINATION } from '../../runtime/data-access/index.js';
import type { ObjectDataAccess } from '../../runtime/data-access/index.js';
import type { SandboxBackend, SandboxInstance } from './backend/types.js';
import { createIsolatedVmSandboxBackend } from './backend/isolated-vm.js';
import { createScriptRpcExecutor } from './bridge.js';
import { loadScriptDir } from './loader.js';
import { createDefaultScriptServices } from './services.js';

export interface ScriptDispatcherOptions {
  /** path to the project `objects/` directory */
  objectsDir: string;
  registry: ObjectRegistry;
  pool: Pool;
  /** RBAC-decorated data-access used by `this.db.objects` */
  dataAccess: ObjectDataAccess;
  /** main-process service implementations; defaults to webhook-capable stubs */
  services?: ScriptServices;
  config?: EngineScriptConfig;
  locale?: Locale;
}

export interface ResolvedScriptConfig {
  timeout: number;
  queryTimeout: number;
  memoryLimit: number;
  maxConcurrentScripts: number;
  /** non-owner role `this.db.query` switches to for row-level security */
  rlsRole: string;
  /** cap on rows a script may fetch per `db.objects(...).find()` call */
  maxObjectsPerQuery: number;
}

/** sandbox resource defaults (`weavekit.config.ts → subsystems.script.sandbox`) */
export const SCRIPT_DEFAULTS = {
  timeout: 5000,
  queryTimeout: 2000,
  memoryLimit: 64 * 1024 * 1024,
  maxConcurrentScripts: 10,
} as const;

export const RLS_ROLE_DEFAULT = 'weavekit_query';

export function resolveScriptConfig(config?: EngineScriptConfig): ResolvedScriptConfig {
  const sandbox = config?.sandbox ?? {};
  return {
    timeout: sandbox.timeout ?? SCRIPT_DEFAULTS.timeout,
    queryTimeout: sandbox.queryTimeout ?? SCRIPT_DEFAULTS.queryTimeout,
    memoryLimit: sandbox.memoryLimit ?? SCRIPT_DEFAULTS.memoryLimit,
    maxConcurrentScripts: sandbox.maxConcurrentScripts ?? SCRIPT_DEFAULTS.maxConcurrentScripts,
    rlsRole: sandbox.rls?.role ?? RLS_ROLE_DEFAULT,
    maxObjectsPerQuery: sandbox.maxObjectsPerQuery ?? PAGINATION.DEFAULT_LIMIT,
  };
}

/** non-queueing concurrency cap: over the limit fails fast instead of deadlocking */
class ConcurrencyGuard {
  private active = 0;

  constructor(private readonly max: number) {}

  tryAcquire(): boolean {
    if (this.active >= this.max) return false;
    this.active += 1;
    return true;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
  }
}

/**
 * Assemble the write-path hook dispatcher.
 *
 * - discovers `objects/<name>/server.js` (only for registered objects)
 * - lazily spawns one sandbox per script on first dispatch
 * - enforces resource limits (timeout / queryTimeout / memory / concurrency)
 * - before-hook errors throw (data-access aborts); after-hook errors are
 *   caught by data-access and surfaced as warnings — the dispatcher itself
 *   always throws on a hook failure and lets the caller decide
 */
export async function createScriptDispatcher(options: ScriptDispatcherOptions): Promise<ScriptDispatcher> {
  const { registry, pool, dataAccess, locale } = options;
  const config = resolveScriptConfig(options.config);
  const services = options.services ?? createDefaultScriptServices();

  let backend: SandboxBackend;
  try {
    backend = createIsolatedVmSandboxBackend({
      timeoutMs: config.timeout,
      queryTimeoutMs: config.queryTimeout,
      memoryLimitMb: Math.max(16, Math.floor(config.memoryLimit / (1024 * 1024))),
    });
  } catch (error) {
    // optional native dependency (`isolated-vm`) missing — fail with an
    // actionable, localized startup error instead of a raw module error
    if (error instanceof Error) console.warn(`[weavekit:script] ${error.message}`);
    throw new SchemaError('script.sandbox.unavailable', {}, locale);
  }
  const executor = createScriptRpcExecutor({
    pool,
    registry,
    dataAccess,
    services,
    queryTimeoutMs: config.queryTimeout,
    rlsRole: config.rlsRole,
    maxObjectsPerQuery: config.maxObjectsPerQuery,
    locale,
  });
  const guard = new ConcurrencyGuard(config.maxConcurrentScripts);

  const scripts = (await loadScriptDir(options.objectsDir)).filter((s) => registry.get(s.name) !== undefined);

  const instances = new Map<string, SandboxInstance>();
  const hooksByObject = new Map<string, Set<ScriptHook>>();
  for (const script of scripts) {
    instances.set(
      script.name,
      backend.create({ name: script.name, source: script.source, hooks: script.hooks }, executor),
    );
    hooksByObject.set(script.name, new Set(script.hooks));
  }

  const hasHook = (objectName: string, hook: ScriptHook): boolean =>
    hooksByObject.get(objectName)?.has(hook) ?? false;

  return {
    has: hasHook,

    async dispatch(objectName, hook, args: ScriptDispatchArgs): Promise<ScriptDispatchResult> {
      if (!hasHook(objectName, hook)) return { warnings: [] };
      const instance = instances.get(objectName);
      if (instance === undefined) return { warnings: [] };

      if (!guard.tryAcquire()) {
        throw new SchemaError('script.busy', { limit: config.maxConcurrentScripts }, locale);
      }
      try {
        const result = await instance.call(hook, args);
        if (!result.ok) {
          const code = result.error?.code ?? 'abort';
          if (code === 'abort') {
            throw new SchemaError('script.abort', { hook, message: result.error?.message ?? 'unknown script error' }, locale);
          }
          throw new SchemaError('script.timeout', { script: `${objectName}.server.js`, timeout: config.timeout }, locale);
        }
        const value = result.value;
        const changes =
          hook === SCRIPT_HOOKS.BEFORE_UPDATE && value !== null && typeof value === 'object'
            ? (value as Record<string, unknown>)
            : undefined;
        const records =
          hook === SCRIPT_HOOKS.ON_LOAD && Array.isArray(value)
            ? (value as Record<string, unknown>[])
            : undefined;
        return { changes, records, warnings: [] };
      } finally {
        guard.release();
      }
    },

    async close() {
      // Aggregate the shutdown-handshake results: a `false` means a worker
      // never acknowledged `closed` (wedged) and was force-terminated, so its
      // isolate release was NOT confirmed — surface that instead of pretending
      // everything released cleanly (dev reload's "workers released" log only
      // tells the truth when this is silent).
      let allConfirmed = true;
      for (const instance of instances.values()) {
        const confirmed = await instance.close();
        if (!confirmed) allConfirmed = false;
      }
      await backend.close();
      if (!allConfirmed) {
        console.warn('[weavekit:script] worker shutdown handshake timed out — forced terminate (isolate release not confirmed)');
      }
    },
  };
}

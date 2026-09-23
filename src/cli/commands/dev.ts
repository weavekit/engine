import { mkdir, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join } from 'node:path';
import kleur from 'kleur';
import { createPool, SchemaError, generateObjectTypes } from '../../index.js';
import { buildEngineFromRegistry } from '../../runtime/engine.js';
import type { WeaveKitEngine, FieldTypeRegistry } from '../../index.js';
import {
  autoCommit,
  buildCommitMessage,
  diffMetadata,
  gitCommitAuthor,
  recordSchemaChanges,
  syncSchema,
  type SyncResult,
} from '../../runtime/git/index.js';
import type { SchemaFile } from '../../runtime/git/index.js';
import { loadConfig } from '../load-config.js';
import { resolveProjectFieldTypes } from '../resolve-field-types.js';
import { PROJECT_TYPES } from '../types/index.js';
import type { DevOptions } from '../types/index.js';
import { backfillDefaultViews } from './default-view.js';
import { firstStaticKey } from '../facts.js';
import { readyScreen, renderReadyScreen } from '../ready-screen.js';

const RELOAD_DEBOUNCE_MS = 300;
const LISTEN_RETRIES = 5;
const LISTEN_RETRY_MS = 300;

/** `weave dev` — engine with hot reload: schema changes sync + rebuild the app */
export async function dev(cwd: string, options: DevOptions): Promise<void> {
  const p = options.printer;
  let config = await loadConfig(cwd);
  const schemaDir = config.schemaDir ?? cwd;

  let engine: WeaveKitEngine | undefined;

  /** build the startup value screen from runtime facts (undefined until the engine is up) */
  function screenFor(): ReturnType<typeof readyScreen> | undefined {
    if (engine === undefined) return undefined;
    const rest = config.adapters?.rest;
    const eventsCfg = config.adapters?.events;
    return readyScreen({
      port: options.port,
      projectType: config.projectType,
      restEnabled: rest?.enabled ?? true,
      restPrefix: rest?.prefix ?? '/api',
      mcpEnabled: engine.mcp !== undefined,
      mcpEndpoint: config.adapters?.mcp?.endpoint ?? '/mcp',
      eventsEnabled: engine.events !== undefined,
      eventsPrefix: eventsCfg?.prefix ?? '/api',
      objects: engine.registry.list().map((o) => o.name),
      audit: engine.audit !== undefined,
      script: engine.script !== undefined,
      events: engine.events !== undefined,
      customTools: engine.tools?.defs.length ?? 0,
      apiKey: firstStaticKey(config.auth?.source),
    });
  }

  /** regenerate object-level TS types (generated/types.ts) to stay in sync */
  async function regenerateTypes(files: SchemaFile[], fieldTypes: FieldTypeRegistry): Promise<void> {
    const source = generateObjectTypes(files.map((f) => f.object), fieldTypes);
    await mkdir(join(cwd, 'generated'), { recursive: true });
    await writeFile(join(cwd, 'generated', 'types.ts'), source);
  }

  /** git-commit schema changes after a successful sync; non-git projects warn and keep going */
  async function commitMetadata(files: SchemaFile[], applied: string[]): Promise<void> {
    try {
      const changes = await diffMetadata(schemaDir, files);
      const commit = await autoCommit({
        dir: schemaDir,
        message: buildCommitMessage(changes),
        paths: config.projectType === PROJECT_TYPES.BUSINESS ? ['objects', 'pages'] : undefined,
      });
      if (commit.committed) p.log(`committed ${commit.sha}`);
      if (commit.committed && changes.length > 0) {
        const author = await gitCommitAuthor(schemaDir);
        // reached only after a successful sync, which required a DB URL
        const pool = createPool(config.databaseUrl ?? process.env.DATABASE_URL!);
        try {
          await recordSchemaChanges(pool, changes, files, { sha: commit.sha, author, applied });
        } finally {
          await pool.end();
        }
      }
    } catch (error) {
      if (error instanceof SchemaError && error.code === 'git.notRepo') {
        p.error('warning: not a git repository — schema changes not committed');
        return;
      }
      throw error;
    }
  }

  /** extract the drifted object/field from a migrate failure (if any) */
  function driftOf(error: unknown): { object: string; field?: string } | null {
    if (error instanceof SchemaError && error.code === 'object.field.columnMissing') {
      const object = typeof error.params.object === 'string' ? error.params.object : undefined;
      const field = typeof error.params.field === 'string' ? error.params.field : undefined;
      if (object !== undefined) return { object, field };
    }
    return null;
  }

  function driftMessage(d: { object: string; field?: string }): string {
    const field = d.field !== undefined ? ` declares field "${d.field}"` : '';
    return `schema/DB drift: object "${d.object}"${field} but the column is missing — run "weave migrate" or set "alter": true in objects/${d.object}/schema.json`;
  }

  async function listen(): Promise<void> {
    if (engine === undefined) return;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await engine.app.listen({ host: '0.0.0.0', port: options.port });
        p.log(`weavekit engine listening on http://localhost:${options.port}`);
        return;
      } catch (error) {
        if (attempt > LISTEN_RETRIES || !String((error as Error).message).includes('EADDRINUSE')) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, LISTEN_RETRY_MS));
      }
    }
  }

  /** backfill missing default page layouts for business projects */
  async function backfillViews(sync: SyncResult): Promise<void> {
    if (config.projectType !== PROJECT_TYPES.BUSINESS) return;
    const written = await backfillDefaultViews(
      schemaDir,
      sync.registry.list().map((o) => ({ name: o.name, fields: o.fields })),
      config.locale,
    );
    if (written.length > 0) p.log(`generated default page layouts for ${written.length} object(s)`);
  }

  async function start(): Promise<void> {
    // always sync Git → PG before serving: per-object `alter: true` objects get
    // additive DDL; alter:false objects fail fast on a missing column
    const fieldTypes = await resolveProjectFieldTypes(cwd, config);
    const sync = await syncSchema({ dir: schemaDir, databaseUrl: config.databaseUrl, locale: config.locale, allowedFieldTypes: config.features?.fieldTypes, fieldTypes });
    await backfillViews(sync);
    await regenerateTypes(sync.files, fieldTypes);
    await commitMetadata(sync.files, sync.migration.applied);
    engine = await buildEngineFromRegistry(sync.registry, config);
    await listen();
    const screen = screenFor();
    if (screen !== undefined) renderReadyScreen(p, screen);
  }

  async function reload(): Promise<void> {
    const previous = engine;

    // re-read the config so weavekit.config.ts changes (subsystem toggles,
    // adapter/identity/auth values, tools.*) take effect on reload
    config = await loadConfig(cwd);
    p.log('change detected — reloading…');
    const fieldTypes = await resolveProjectFieldTypes(cwd, config);

    // Phase 1 — validate + migrate BEFORE touching the running engine.
    // migrate() uses no port, so the old engine keeps serving while this runs.
    // On drift (an alter:false object's declared field has no column) the reload
    // is rejected and the running engine stays up.
    let sync: SyncResult;
    try {
      sync = await syncSchema({ dir: schemaDir, databaseUrl: config.databaseUrl, locale: config.locale, allowedFieldTypes: config.features?.fieldTypes, fieldTypes });
    } catch (error) {
      const drift = driftOf(error);
      const message = drift !== null ? driftMessage(drift) : error instanceof Error ? error.message : String(error);
      if (drift !== null && previous?.events !== undefined) {
        previous.events.publishSchemaDrift({ object: drift.object, field: drift.field, message });
      }
      p.error(`reload rejected: ${message}`);
      p.error('engine keeps serving the previous schema — fix the schema and save again');
      return;
    }

    // Phase 2 — swap: release the old engine (port + isolates), then build the
    // new one from the already-synced registry. engine.close() composes app.close
    // → mcp.close → script.close → buffered flush → audit.close → pool.end, and
    // script.close runs the isolated-vm worker shutdown handshake, all awaited —
    // so V8 isolates never overlap create/dispose in one process (the race behind
    // the native isolated-vm assert on Windows).
    if (previous !== undefined) {
      try {
        await previous.close();
        if (previous.script !== undefined) {
          p.log('script sandbox workers released');
        }
      } catch (error) {
        // a close failure must not crash the watcher (an uncaught rejection
        // would terminate the process) — log and still try to restart
        p.error(`close failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      await backfillViews(sync);
      await regenerateTypes(sync.files, fieldTypes);
      await commitMetadata(sync.files, sync.migration.applied);
      const next = await buildEngineFromRegistry(sync.registry, config);
      engine = next;
      await listen();
      p.log(`${kleur.green('reloaded')}${kleur.dim(` · ${next.registry.list().length} object(s)`)}`);
    } catch (error) {
      engine = undefined;
      // keep watching instead of exiting: a fixed schema/config reloads on the
      // next save
      p.error(`reload failed: ${error instanceof Error ? error.message : String(error)}`);
      p.error('engine is down — fix the schema/config and save again to reload');
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let reloading = false;
  let pending = false;
  let stopping = false;

  /** serialized reload: overlapping change bursts coalesce into one rebuild */
  async function scheduleReload(): Promise<void> {
    if (reloading) {
      pending = true;
      return;
    }
    reloading = true;
    try {
      await reload();
    } finally {
      reloading = false;
      if (pending) {
        pending = false;
        timer = setTimeout(() => {
          timer = undefined;
          void scheduleReload();
        }, RELOAD_DEBOUNCE_MS);
      }
    }
  }

  const watcher = watch(join(schemaDir, 'objects'), { recursive: true }, () => {
    if (stopping || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void scheduleReload();
    }, RELOAD_DEBOUNCE_MS);
  });

  // config is the truth source too — weavekit.config.ts changes (subsystem
  // enable/disable, adapter/identity values) must hot-reload, not just schema
  const configWatcher = watch(join(cwd, 'weavekit.config.ts'), () => {
    if (stopping || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void scheduleReload();
    }, RELOAD_DEBOUNCE_MS);
  });

  const shutdown = async (): Promise<void> => {
    stopping = true;
    watcher.close();
    configWatcher.close();
    // lifecycle.shutdown is emitted inside engine.close() so every shutdown path
    // (this, and production main.ts) signals monitored instances uniformly.
    await engine?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await start();
  p.log('watching for schema changes… (Ctrl+C to stop)');
}

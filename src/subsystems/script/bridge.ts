import type { Pool } from 'pg';
import type { Locale, ObjectRegistry, ScriptServices } from '../../core/index.js';
import type { DataAccessContext, ObjectDataAccess } from '../../runtime/data-access/index.js';
import { enforceSqlGates, executeRestrictedSql } from '../../runtime/data-access/index.js';
import { createSqlAnalyzer } from '../../runtime/sql-analyzer/index.js';
import type { RpcExecutor, RpcRequest } from './backend/types.js';

export interface ScriptBridgeOptions {
  pool: Pool;
  registry: ObjectRegistry;
  /** RBAC-decorated object data-access — `this.db.objects` runs through it */
  dataAccess: ObjectDataAccess;
  /** main-process service implementations (`this.services`) */
  services: ScriptServices;
  /** per-call timeout in ms (`queryTimeout`) */
  queryTimeoutMs: number;
  /** non-owner role `this.db.query` switches to for row-level security (RLS) */
  rlsRole: string;
  /** cap on rows a script may fetch per `db.objects(...).find()` call */
  maxObjectsPerQuery: number;
  /** restricted SQL row cap */
  maxRows?: number;
  locale?: Locale;
}

/** time-box an async call — rejects with a plain error after `ms` */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`query timeout after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The main-process executor for sandbox RPCs. Receives a call posted by the
 * worker and runs it against the real engine resources, always with the
 * script author's identity rebuilt as an `RbacSubject` so `withRbac` enforces
 * permissions on every `this.db.objects` call.
 */
export function createScriptRpcExecutor(options: ScriptBridgeOptions): RpcExecutor {
  const { pool, registry, dataAccess, services, locale } = options;
  const analyzer = createSqlAnalyzer();
  // warm up the WASM module at engine startup so the first db.query has no cold start
  void analyzer.ensureLoaded();

  async function handleObjects(req: RpcRequest, timeoutMs: number): Promise<unknown> {
    const [objectName, method, ...rest] = req.args as [string, string, ...unknown[]];
    // clamp the rows a script may request per find call (findOne uses limit 1)
    if (method === 'find' && rest[0] !== undefined && typeof rest[0] === 'object' && !Array.isArray(rest[0])) {
      const opts = rest[0] as { limit?: number };
      const cap = options.maxObjectsPerQuery;
      if (cap !== undefined) opts.limit = Math.max(1, Math.min(opts.limit ?? cap, cap));
    }
    const ctx: DataAccessContext = {
      pool,
      registry,
      subject: { id: req.user.id, roles: req.user.roles, teamId: req.user.teamId },
      locale,
    };
    const fn = (dataAccess as unknown as Record<string, unknown>)[method];
    if (typeof fn !== 'function') {
      throw new Error(`unknown db.objects method: ${method}`);
    }
    return withTimeout(
      (fn as (name: string, ...args: unknown[]) => Promise<unknown>).call(dataAccess, objectName, ...rest, ctx),
      timeoutMs,
    );
  }

  async function handleQuery(req: RpcRequest, timeoutMs: number): Promise<unknown> {
    const [sql, params] = req.args as [string, unknown[]];
    // RBAC gates: read permission + team scope + field exclude over the parsed
    // table/column references (row-level scope is PostgreSQL RLS, see C2 design)
    const analysis = await analyzer.analyzeSelect(sql, locale);
    enforceSqlGates({
      analysis,
      registry,
      roles: req.user.roles,
      teamId: req.user.teamId,
      locale,
    });
    return executeRestrictedSql(pool, sql, params, {
      maxRows: options.maxRows,
      timeoutMs,
      rls: {
        role: options.rlsRole,
        subject: { id: req.user.id, roles: req.user.roles, teamId: req.user.teamId },
      },
    });
  }

  async function handleServices(req: RpcRequest, timeoutMs: number): Promise<unknown> {
    const args = (req.args[0] ?? {}) as Record<string, unknown>;
    let call: Promise<unknown>;
    switch (req.method) {
      case 'email.send':
        call = services.email.send(args as unknown as Parameters<ScriptServices['email']['send']>[0]) as Promise<unknown>;
        break;
      case 'slack.post':
        call = services.slack.post(args as unknown as Parameters<ScriptServices['slack']['post']>[0]) as Promise<unknown>;
        break;
      case 'webhook.call':
        call = services.webhook.call(args as unknown as Parameters<ScriptServices['webhook']['call']>[0]) as Promise<unknown>;
        break;
      default:
        throw new Error(`unknown service: ${req.method}`);
    }
    return withTimeout(call, timeoutMs);
  }

  return async (req, timeoutMs): Promise<unknown> => {
    switch (req.ns) {
      case 'objects':
        return handleObjects(req, timeoutMs);
      case 'query':
        return handleQuery(req, timeoutMs);
      case 'services':
        return handleServices(req, timeoutMs);
      case 'console': {
        const level = req.method as 'log' | 'warn' | 'error' | 'info';
        const logger = console[level] ?? console.log;
        logger(...(req.args as unknown[]));
        return undefined;
      }
      default:
        throw new Error(`unknown rpc namespace: ${req.ns}`);
    }
  };
}

/**
 * Script subsystem contract — pure interfaces, zero dependencies.
 *
 * The engine never parses `*.server.js` itself: the sandbox implementation
 * lives in `subsystems/script` and is injected at assembly time via a
 * `ScriptDispatcher` (NOOP when disabled = zero imports, zero overhead).
 * Data-access and adapter layers depend on this contract only.
 */

/** lifecycle hook names — single source of truth (as const, see AGENTS.md) */
export const SCRIPT_HOOKS = {
  ON_LOAD: 'onLoad',
  VALIDATE: 'validate',
  BEFORE_UPDATE: 'beforeUpdate',
  AFTER_UPDATE: 'afterUpdate',
  BEFORE_DELETE: 'beforeDelete',
  AFTER_DELETE: 'afterDelete',
  BEFORE_TRANSITION: 'beforeTransition',
  AFTER_TRANSITION: 'afterTransition',
  ON_ENTER: 'onEnter',
  ON_EXIT: 'onExit',
  ON_TIMEOUT: 'onTimeout',
} as const;
export type ScriptHook = typeof SCRIPT_HOOKS[keyof typeof SCRIPT_HOOKS];

/** `this.user` — who triggered the operation */
export interface ScriptUser {
  id: string;
  name?: string;
  roles: string[];
  /** team id, required for `team`-scoped row access (RLS + rowScope) */
  teamId?: string;
}

/** filter/sort shapes are structurally compatible with the data-access layer */
export interface ScriptSort {
  field: string;
  dir: 'asc' | 'desc';
}

export interface ScriptFindOptions {
  filter?: Record<string, unknown>;
  sort?: ScriptSort[];
  limit?: number;
  offset?: number;
  fields?: string[];
}

export interface ScriptFindResult<T = Record<string, unknown>> {
  rows: T[];
  total: number;
}

/** `this.db.objects(name)` — RBAC-enforced object query builder */
export interface ScriptObjectQueryBuilder {
  find<T = Record<string, unknown>>(opts?: ScriptFindOptions): Promise<ScriptFindResult<T>>;
  findOne<T = Record<string, unknown>>(id: string): Promise<T | null>;
  create<T = Record<string, unknown>>(data: Record<string, unknown>): Promise<T>;
  update<T = Record<string, unknown>>(id: string, changes: Record<string, unknown>): Promise<T>;
  delete(id: string): Promise<void>;
}

export interface ScriptRestrictedQueryResult {
  rows: unknown[];
}

/** `this.db` — controlled data access (never direct DB access) */
export interface ScriptDb {
  objects(name: string): ScriptObjectQueryBuilder;
  query(sql: string, params: unknown[]): Promise<ScriptRestrictedQueryResult>;
}

export interface ScriptEmailSendOptions {
  to: string | string[];
  subject: string;
  body: string;
  from?: string;
}

export interface ScriptSlackPostOptions {
  channel?: string;
  text: string;
}

export interface ScriptWebhookCallOptions {
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
}

/** `this.services` — bridge to engine main-process providers (no sandbox networking) */
export interface ScriptServices {
  email: { send(opts: ScriptEmailSendOptions): Promise<{ messageId?: string }> };
  slack: { post(opts: ScriptSlackPostOptions): Promise<void> };
  webhook: { call(opts: ScriptWebhookCallOptions): Promise<unknown> };
}

/**
 * The full `this` shape exposed to a hook function. Only `record`/`records`/
 * `changes`/`user`/`transition`/`state` are plain data; `db`/`services` are RPC
 * proxies that bridge back to the engine main process.
 */
export interface ScriptContext {
  /** current record (pre-write). null on create */
  record: Record<string, unknown> | null;
  /** read hook (`onLoad`): the whole fetched batch, transformed by the return */
  records?: Record<string, unknown>[] | null;
  /** write payload (create data / update changes) */
  changes: Record<string, unknown>;
  user: ScriptUser;
  db: ScriptDb;
  services: ScriptServices;
  /** workflow transition info; set only for workflow hooks */
  transition?: { from?: string; to?: string; label?: string } | null;
  /** current state name; set only for onEnter/onExit/onTimeout */
  state?: string | null;
}

/** what data-access hands to the dispatcher for one hook invocation */
export interface ScriptDispatchArgs {
  record: Record<string, unknown> | null;
  /** read hook (`onLoad`): the fetched batch (never set for write hooks) */
  records?: Record<string, unknown>[] | null;
  changes: Record<string, unknown>;
  user: ScriptUser;
  transition?: { from?: string; to?: string; label?: string } | null;
  state?: string | null;
}

export interface ScriptDispatchResult {
  /** possibly-modified changes returned by beforeUpdate (used for the write) */
  changes?: Record<string, unknown>;
  /** possibly-transformed records returned by onLoad (must be same length) */
  records?: Record<string, unknown>[];
  /** non-fatal errors from after hooks (write already committed) */
  warnings: string[];
}

/**
 * Write-path hook dispatcher contract. Data-access calls `has` as a fast-path
 * skip and `dispatch` around writes; the implementation (subsystems/script)
 * is injected at assembly time. NOOP when disabled.
 */
export interface ScriptDispatcher {
  /** whether any hook is registered for this object+hook */
  has(objectName: string, hook: ScriptHook): boolean;
  dispatch(
    objectName: string,
    hook: ScriptHook,
    args: ScriptDispatchArgs,
  ): Promise<ScriptDispatchResult>;
  close(): Promise<void>;
}

/** disabled script subsystem → zero overhead pass-through */
export const NOOP_SCRIPT_DISPATCHER: ScriptDispatcher = {
  has: () => false,
  dispatch: async () => ({ warnings: [] }),
  close: async () => {},
};

/** `weavekit.config.ts → subsystems.script` */
export interface EngineScriptSandboxConfig {
  /** overall hook timeout in ms; default 5000 */
  timeout?: number;
  /** per this.db call timeout in ms; default 2000 */
  queryTimeout?: number;
  /** sandbox heap limit in bytes; default 64 MiB */
  memoryLimit?: number;
  /** max concurrently executing scripts per object; default 10 */
  maxConcurrentScripts?: number;
  /**
   * row-level security for `this.db.query`. When the script subsystem is enabled
   * this is on by default: `db.query` switches to a dedicated non-owner role
   * (`SET LOCAL ROLE`) so PostgreSQL RLS scopes its rows, and migrate emits the
   * `ENABLE ROW LEVEL SECURITY` + policy + GRANT DDL (default role:
   * `weavekit_query`).
   */
  rls?: { role?: string };
  /**
   * cap on rows a script may fetch per `this.db.objects(...).find()` call
   * (clamped, never below 1). Defaults to the data-access default limit (100);
   * the global page cap (1000) still applies to REST/MCP.
   */
  maxObjectsPerQuery?: number;
}

export interface EngineScriptConfig {
  enabled?: boolean;
  sandbox?: EngineScriptSandboxConfig;
  /**
   * main-process service implementations for `this.services` (email/slack/
   * webhook). Defaults to webhook-capable stubs; provide e.g. nodemailer or a
   * Slack webhook URL via env.
   */
  services?: ScriptServices;
}

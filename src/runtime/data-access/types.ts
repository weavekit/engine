import type { Pool, PoolClient } from "pg";
import type { Locale } from "../../core/index.js";
import type { ObjectRegistry } from "../../core/index.js";
import type { AccessPrincipal, IdentitySubject } from "../../core/index.js";
import { principalSubject } from "../../core/index.js";
import type { FilterOp, SortDir } from "./values.js";
import type { WorkflowStatus, WorkflowHistory, WorkflowTodo, WorkflowOverride } from "./workflow.js";

/** pool or pooled client — anything that can run parameterized queries */
export type Queryable = Pool | PoolClient;

export type FilterValue = { [op in FilterOp]?: unknown };

/** a single equality/operator object filter — conditions across fields are AND'd */
export type FilterGroup = { [field: string]: unknown | FilterValue };

/**
 * Filter contract (REST `filter` JSON):
 * - plain object form (AND across fields), e.g. `{ status: 'open', amount: { gte: 100 } }`
 * - OR across groups via the reserved top-level `$or` key:
 *   `{ $or: [ { status: 'open' }, { amount: { gte: 100 } } ] }` → `(status = 'open' OR amount >= 100)`
 * `$or` groups AND with any top-level field conditions and with the RBAC row scope.
 */
export type Filter = FilterGroup & { $or?: FilterGroup[] };

export interface Sort {
  field: string;
  dir: SortDir;
}

export interface FindOptions {
  filter?: Filter;
  sort?: Sort[];
  /** rows per page; defaults to PAGINATION.DEFAULT_LIMIT, capped at PAGINATION.MAX_LIMIT */
  limit?: number;
  /** rows to skip; defaults to PAGINATION.DEFAULT_OFFSET */
  offset?: number;
  /** column projection whitelist */
  fields?: string[];
  /** columns always excluded from the projection (RBAC fields.exclude) */
  exclude?: string[];
  /**
   * Opaque keyset cursor (see `cursor.ts`). When set on an object with a single
   * primary key, the page is fetched with `pk > cursor` ordered by `pk` (a
   * caller-provided `sort` is ignored); REST keeps using `offset`.
   */
  cursor?: string;
}

export interface FindResult<T = Record<string, unknown>> {
  rows: T[];
  total: number;
  /** next-page keyset cursor (present only when a cursor was used and more remain) */
  nextCursor?: string;
  /** whether more rows exist beyond this page (offset or cursor mode) */
  hasMore?: boolean;
}

/**
 * Execution context for data-access operations. `rowScope` is the RBAC
 * row-level filter (own/all) injected by the RBAC layer. `principal` is the
 * explicit actor (user or system capability) — there is no implicit
 * unrestricted path. `client` threads an outer transaction: when set, write
 * operations reuse the connection and the surrounding transaction instead of
 * BEGIN/COMMIT/ROLLBACK themselves (see `runtime/data-access/tx.ts`).
 */
export interface DataAccessContext {
  pool: Pool;
  registry: ObjectRegistry;
  /** extra WHERE fragment (AND'd), injected by the RBAC layer for own/team/all scope */
  rowScope?: { sql: string; params: unknown[] };
  /** who is acting — an authenticated user or an explicit system capability (required) */
  principal: AccessPrincipal;
  locale?: Locale;
  /** outer transaction connection; present inside `withTx` (skips nested BEGIN/COMMIT/release) */
  client?: PoolClient;
  /** request correlation id (Fastify request id / inbound x-request-id) attached to audit events */
  requestId?: string;
  /**
   * channel for non-fatal write warnings — afterUpdate/afterDelete script hooks
   * fail after the write is committed; the messages are delivered here so the
   * API layer can surface them (e.g. a `warnings` array on the response)
   */
  onWarnings?: (warnings: string[]) => void;
}

/** the authenticated identity for a user principal, else undefined (system principal) */
export function subjectOf(ctx: DataAccessContext): IdentitySubject | undefined {
  return principalSubject(ctx.principal);
}

/** true when the context is an explicit system principal (unrestricted path) */
export function isSystemCtx(ctx: DataAccessContext): boolean {
  return ctx.principal.kind === 'system';
}

/** contract for the controlled object data-access layer */
export interface ObjectDataAccess {
  find<T = Record<string, unknown>>(
    objectName: string,
    opts: FindOptions,
    ctx: DataAccessContext,
  ): Promise<FindResult<T>>;
  findOne<T = Record<string, unknown>>(
    objectName: string,
    id: string,
    ctx: DataAccessContext,
  ): Promise<T | null>;
  create<T = Record<string, unknown>>(
    objectName: string,
    data: Record<string, unknown>,
    ctx: DataAccessContext,
  ): Promise<T>;
  update<T = Record<string, unknown>>(
    objectName: string,
    id: string,
    changes: Record<string, unknown>,
    ctx: DataAccessContext,
  ): Promise<T>;
  /**
   * Fire a workflow action against the three-layer runtime (`objects/<name>/workflow.json`):
   * resolve the node the record is at, evaluate the workitem quorum, open the
   * next step/workitems and update the side-table status mirror atomically. The
   * object must declare a workflow; unknown/disallowed actions throw
   * (`workflow.transition.unknown` / `workflow.transition.notAllowed`).
   * `payload` carries action extras (`{ to: { userId } }` for `forward`,
   * `{ comment }`).
   */
  transition<T = Record<string, unknown>>(
    objectName: string,
    id: string,
    action: string,
    ctx: DataAccessContext,
    payload?: Record<string, unknown>,
  ): Promise<T>;
  delete(objectName: string, id: string, ctx: DataAccessContext): Promise<void>;
  /** read a record's workflow status (state/node/actions/own workitems) */
  workflowStatus(objectName: string, id: string, ctx: DataAccessContext): Promise<WorkflowStatus>;
  /** acquire/renew the caller's presence lock on the current step (TTL lease) */
  acquireWorkflowLock(objectName: string, id: string, ctx: DataAccessContext): Promise<{ expiresAt: Date }>;
  /** release the caller's presence lock */
  releaseWorkflowLock(objectName: string, id: string, ctx: DataAccessContext): Promise<void>;
  /** read a record's workflow history (steps + workitems) */
  workflowHistory(objectName: string, id: string, ctx: DataAccessContext): Promise<WorkflowHistory>;
  /** the subject's pending workitems across all objects */
  workflowTodos(ctx: DataAccessContext): Promise<WorkflowTodo[]>;
  /** admin override: jump the record to a node or terminate the instance */
  overrideWorkflow(
    objectName: string,
    id: string,
    patch: WorkflowOverride,
    ctx: DataAccessContext,
  ): Promise<{ state: string; nodeId?: string }>;
}

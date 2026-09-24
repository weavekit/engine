import type { Pool, PoolClient } from "pg";
import type { Locale } from "../../core/index.js";
import type { ObjectRegistry } from "../../core/index.js";
import type { RbacSubject } from "../../core/index.js";
import type { FilterOp, SortDir } from "./values.js";

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
}

export interface FindResult<T = Record<string, unknown>> {
  rows: T[];
  total: number;
}

/**
 * Execution context for data-access operations. `rowScope` is the RBAC
 * row-level filter (own/all) injected by the RBAC layer; consumers may
 * leave it unset to access all rows. `subject` is the authenticated identity
 * the RBAC layer decides for; absent = unrestricted. `client` threads an
 * outer transaction: when set, write operations reuse the connection and the
 * surrounding transaction instead of BEGIN/COMMIT/ROLLBACK themselves
 * (see `runtime/data-access/tx.ts`).
 */
export interface DataAccessContext {
  pool: Pool;
  registry: ObjectRegistry;
  /** extra WHERE fragment (AND'd), injected by the RBAC layer for own/team/all scope */
  rowScope?: { sql: string; params: unknown[] };
  /** authenticated identity for RBAC decisions; absent = no enforcement */
  subject?: RbacSubject;
  locale?: Locale;
  /** outer transaction connection; present inside `withTx` (skips nested BEGIN/COMMIT/release) */
  client?: PoolClient;
  /**
   * channel for non-fatal write warnings — afterUpdate/afterDelete script hooks
   * fail after the write is committed; the messages are delivered here so the
   * API layer can surface them (e.g. a `warnings` array on the response)
   */
  onWarnings?: (warnings: string[]) => void;
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
   * Fire a declared workflow transition (`objects/<name>/workflow.json`): resolve
   * the transition for the record's current state, check role permissions, run the
   * workflow hooks and write the target state atomically. The object must declare a
   * workflow; unknown/disallowed transitions throw (`workflow.transition.unknown` /
   * `workflow.transition.notAllowed`).
   */
  transition<T = Record<string, unknown>>(
    objectName: string,
    id: string,
    action: string,
    ctx: DataAccessContext,
  ): Promise<T>;
  delete(objectName: string, id: string, ctx: DataAccessContext): Promise<void>;
}

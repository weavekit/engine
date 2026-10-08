import type { Pool } from 'pg';
import type { IdentitySubject, Locale, ObjectRegistry } from '../../core/index.js';
import type { ObjectDataAccess } from '../../runtime/data-access/index.js';

/**
 * The slice of the assembled engine the GraphQL adapter needs. The adapter is
 * protocol translation only — it consumes the same RBAC-decorated data-access
 * contract as REST/MCP (no new security layer; RBAC/RLS/audit come from the
 * data-access layer).
 */
export interface GraphQLEngine {
  registry: ObjectRegistry;
  pool: Pool;
  dataAccess: ObjectDataAccess;
  locale: Locale;
}

/** per-request GraphQL execution context (the authenticated subject + engine). */
export interface GraphQLContext {
  subject: IdentitySubject;
  engine: GraphQLEngine;
  loader: RecordLoader;
  /** request correlation id, attached to audit events */
  requestId?: string;
}

/**
 * Per-request, same-tick batching loader for nested relation resolution. Each
 * `load`/`loadChildren` collapses every request made in the same execution tick
 * into one data-access query, so a list of N records with a relation is one
 * query per layer instead of N (kills the N+1).
 */
export interface RecordLoader {
  /** one record by its `weave_id`, or null when absent/out of scope */
  load(objectName: string, recordKey: string): Promise<Record<string, unknown> | null>;
  /** the `details` children of a parent record (ordered by `parent_idx`) */
  loadChildren(childObject: string, parentKey: string): Promise<Record<string, unknown>[]>;
}

/**
 * Query hardening. `maxDepth` / `maxComplexity` / `maxAliases` are enforced
 * before execution (Phase 1+); `introspection` and `allowList` land in Phase 4.
 */
export interface GraphQLSecurityConfig {
  /** maximum selection-set depth; defaults to 10 */
  maxDepth?: number;
  /** maximum query cost (fields weighted by list limits) */
  maxComplexity?: number;
  /** maximum aliases per operation */
  maxAliases?: number;
  /** allow `__schema` / `__type` introspection; defaults to true */
  introspection?: boolean;
  /** persist-approved-operation allow list (Git versioned), enforced in Phase 4 */
  allowList?: { enabled: boolean; file?: string };
}

/** GraphQL adapter configuration (`adapters.graphql`). Disabled unless declared. */
export interface EngineGraphQLConfig {
  /** default false: the adapter is mounted only when explicitly enabled */
  enabled?: boolean;
  /** HTTP path the endpoint is mounted on; defaults to `/graphql` */
  prefix?: string;
  /** query hardening (depth / complexity / alias / introspection / allow list) */
  security?: GraphQLSecurityConfig;
  /** per-key sliding-window rate limiting (Bearer key); disabled when absent */
  rateLimit?: { windowMs?: number; max?: number };
}

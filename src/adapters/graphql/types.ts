import type { Pool } from 'pg';
import type { Locale, ObjectRegistry } from '../../core/index.js';
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

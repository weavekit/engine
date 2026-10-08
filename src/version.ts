/** engine version — single source of truth for CLI, ops routes and MCP metadata */
export const version = '0.11.0';

/**
 * Frozen public-contract version (G1). Bump only on a **breaking** change to the
 * frozen surface (schema/workflow format, REST routes, MCP tool names, event
 * types, error codes, data-access/RBAC contracts, package exports) — i.e. at a
 * major release. Additive changes do not bump it. See `docs/` "Contract freeze".
 */
export const CONTRACT_VERSION = 1;

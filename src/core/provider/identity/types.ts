import type { RbacSubject } from '../../rbac/index.js';

/**
 * Resolve a user reference (e.g. the MCP `X-Weavekit-On-Behalf-Of` header)
 * into the subject RBAC decisions run against. Implementations return null for
 * unknown references (callers reject) — an empty directory rejects everything.
 *
 * May be async: production resolvers typically load the user (and their roles
 * / team) from the customer's own database.
 */
export type IdentityResolver = (ref: string) => RbacSubject | null | Promise<RbacSubject | null>;

import type { RbacSubject } from '../core/rbac/index.js';
import type { IdentityResolver } from '../core/provider/identity/index.js';

/**
 * Default identity resolver backed by a static directory of subjects.
 * Exact-match on the reference; unknown refs (and empty directories) resolve
 * to null so callers can reject. MCP assembly may override with a custom
 * `resolveIdentity`.
 */
export function createIdentityResolver(identities: Record<string, RbacSubject>): IdentityResolver {
  return (ref: string) => identities[ref] ?? null;
}

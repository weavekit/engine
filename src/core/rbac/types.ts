/**
 * RBAC runs against the engine's internal identity subject; the contract lives
 * with the identity provider (`core/provider/identity`) and is re-exported here
 * for RBAC's own consumers.
 */
export type { IdentitySubject } from '../provider/identity/types.js';

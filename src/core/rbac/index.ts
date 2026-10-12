export type { IdentitySubject } from './types.js';
export type { ResolvedPermission } from './resolve.js';
export type { RowScopeFragment } from './rowScope.js';
export { resolvePermission } from './resolve.js';
export {
  canCreate,
  canDelete,
  canUpdate,
  canUpdateField,
  allowedUpdateFields,
  assertCanCreate,
  assertCanUpdate,
  assertCanDelete,
  assertCanUpdateField,
} from './authorize.js';
export { buildRowScope } from './rowScope.js';
export { resolvePermissionFor, buildRowScopeFor, type ObjectLookup } from './details.js';
export { scopeFieldName, scopeMarkerOf } from './scopeMarker.js';
export { excludedFields } from './fields.js';
export {
  buildRlsPolicy,
  buildRlsPolicyDdl,
  buildRlsGrantDdl,
  policyName,
  isSafeRlsRole,
  rlsPolicyComment,
  buildObjectRlsPolicies,
  OBJECT_RLS_POLICIES,
  OBJECT_RLS_ROLE_DEFAULT,
  type ObjectRlsPolicy,
} from './rls.js';

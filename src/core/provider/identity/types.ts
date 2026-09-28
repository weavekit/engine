/**
 * Identity contracts (provider layer, pure — no I/O, no protocol libraries).
 *
 * Three responsibilities are kept separate:
 *  - **AuthN** verifies a credential and yields a {@link VerifiedIdentity}
 *  - **Directory** resolves a reference/claims into the internal
 *    {@link IdentitySubject} RBAC/audit/workflow consume
 *  - **Provisioning** imports a normalized snapshot via {@link IdentitySource}
 *    (see `source.ts`) into the local directory (`directory.ts`)
 *
 * The engine owns the internal id space: every subject id is a `weavekit_user`
 * uuid, regardless of which external source the person came from.
 */

/** the internal identity RBAC decisions run against (internal uuid id space) */
export interface IdentitySubject {
  id: string;
  roles: string[];
  /** @deprecated team scope; superseded by `departmentId` when row RBAC moves to departments */
  teamId?: string;
  /** department whose subtree the subject may read (department scope) */
  departmentId?: string;
}

/** an authenticated but not-yet-resolved identity (a verifier's output) */
export interface VerifiedIdentity {
  /** external user reference (the credential subject / claim the verifier trusts) */
  ref: string;
  /** raw claims the verifier surfaced (e.g. OIDC claims) */
  claims?: Record<string, unknown>;
}

/** one user as imported from an identity source (normalized, source-agnostic) */
export interface IdentityUser {
  externalId: string;
  name?: string;
  email?: string;
  mobile?: string;
  roles?: string[];
  /** external id of the department this user belongs to */
  departmentExternalId?: string;
  /** external id of the user's direct manager (reporting line) */
  directorExternalId?: string;
  enabled?: boolean;
  attributes?: Record<string, unknown>;
}

/** one department (org unit) as imported from an identity source */
export interface IdentityDepartment {
  externalId: string;
  name?: string;
  code?: string;
  /** external id of the parent department (org hierarchy) */
  parentExternalId?: string;
  /** external id of the department head */
  managerExternalId?: string;
  enabled?: boolean;
}

/** one pull from an identity source */
export interface IdentityPullResult {
  users: IdentityUser[];
  departments: IdentityDepartment[];
  /** incremental cursor for the next pull (source-defined watermark) */
  cursor?: string;
}

/**
 * Resolve a user reference (e.g. the MCP `X-Weavekit-On-Behalf-Of` header) into
 * the subject RBAC decisions run against. Implementations return null for
 * unknown references (callers reject) — an empty directory rejects everything.
 */
export type IdentityResolver = (ref: string) => IdentitySubject | null | Promise<IdentitySubject | null>;

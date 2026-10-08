import type { IdentitySubject } from '../provider/identity/index.js';

/**
 * Explicit access principal — single source of truth for "who is acting".
 *
 * Replaces the implicit `subject === undefined` (= unrestricted) convention:
 * callers must state either an authenticated `user` or a deliberate `system`
 * capability, so a forgotten field can no longer silently bypass RBAC.
 */
export const SYSTEM_CAPABILITIES = {
  WORKFLOW_TIMER: 'workflow.timer',
  INTERNAL_ADMIN: 'internal.admin',
} as const;
export type SystemCapability = typeof SYSTEM_CAPABILITIES[keyof typeof SYSTEM_CAPABILITIES];

export type AccessPrincipal =
  | { kind: 'user'; subject: IdentitySubject }
  | { kind: 'system'; capability: SystemCapability; reason?: string; tenantId?: string };

/** build a user principal */
export function userPrincipal(subject: IdentitySubject): AccessPrincipal {
  return { kind: 'user', subject };
}

/** build a system principal (an optional tenant scopes a system actor) */
export function systemPrincipal(capability: SystemCapability, reason?: string, tenantId?: string): AccessPrincipal {
  return {
    kind: 'system',
    capability,
    ...(reason === undefined ? {} : { reason }),
    ...(tenantId === undefined ? {} : { tenantId }),
  };
}

/** the authenticated identity for a user principal, else undefined */
export function principalSubject(principal: AccessPrincipal): IdentitySubject | undefined {
  return principal.kind === 'user' ? principal.subject : undefined;
}

/** the tenant a principal acts within (user subject's tenant, or a system principal's) */
export function principalTenantId(principal: AccessPrincipal): string | undefined {
  return principal.kind === 'user' ? principal.subject.tenantId : principal.tenantId;
}

/** true for a system principal */
export function isSystemPrincipal(
  principal: AccessPrincipal,
): principal is Extract<AccessPrincipal, { kind: 'system' }> {
  return principal.kind === 'system';
}

/** audit actor id for a principal (`<subject.id>` or `system:<capability>`) */
export function principalActorId(principal: AccessPrincipal): string {
  return principal.kind === 'user' ? principal.subject.id : `system:${principal.capability}`;
}

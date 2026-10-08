import { describe, it, expect } from '../helpers/test.js';
import {
  SYSTEM_CAPABILITIES,
  principalSubject,
  systemPrincipal,
  userPrincipal,
} from '../../src/core/index.js';
import { isSystemCtx, subjectOf } from '../../src/runtime/data-access/index.js';

describe('AccessPrincipal resolution', () => {
  it('principalSubject: user → subject, system → undefined', () => {
    const subject = { id: 'u1', roles: ['sales'] };
    expect(principalSubject(userPrincipal(subject))).toBe(subject);
    expect(principalSubject(systemPrincipal(SYSTEM_CAPABILITIES.INTERNAL_ADMIN))).toBeUndefined();
  });

  it('subjectOf / isSystemCtx: user principal is scoped', () => {
    const subject = { id: 'u1', roles: ['sales'] };
    const ctx = { principal: userPrincipal(subject) } as never;
    expect(subjectOf(ctx)).toBe(subject);
    expect(isSystemCtx(ctx)).toBe(false);
  });

  it('subjectOf / isSystemCtx: system principal is unrestricted', () => {
    const ctx = { principal: systemPrincipal(SYSTEM_CAPABILITIES.INTERNAL_ADMIN, 'seed') } as never;
    expect(subjectOf(ctx)).toBeUndefined();
    expect(isSystemCtx(ctx)).toBe(true);
  });
});

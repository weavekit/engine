import { describe, it, expect } from '../helpers/test.js';
import {
  SYSTEM_CAPABILITIES,
  principalSubject,
  systemPrincipal,
  userPrincipal,
} from '../../src/core/index.js';
import { isSystemCtx, principalOf, subjectOf } from '../../src/runtime/data-access/index.js';

describe('AccessPrincipal resolution', () => {
  it('principalSubject: user → subject, system → undefined', () => {
    const subject = { id: 'u1', roles: ['sales'] };
    expect(principalSubject(userPrincipal(subject))).toBe(subject);
    expect(principalSubject(systemPrincipal(SYSTEM_CAPABILITIES.INTERNAL_ADMIN))).toBeUndefined();
  });

  it('an explicit principal wins over the deprecated subject shorthand', () => {
    const explicit = systemPrincipal(SYSTEM_CAPABILITIES.WORKFLOW_TIMER, 'timer');
    const ctx = { principal: explicit, subject: { id: 'legacy', roles: [] } } as never;
    expect(principalOf(ctx)).toBe(explicit);
    expect(subjectOf(ctx)).toBeUndefined();
    expect(isSystemCtx(ctx)).toBe(true);
  });

  it('subject shorthand → user principal', () => {
    const subject = { id: 'u1', roles: ['sales'] };
    expect(principalOf({ subject } as never)).toEqual(userPrincipal(subject));
    expect(subjectOf({ subject } as never)).toBe(subject);
    expect(isSystemCtx({ subject } as never)).toBe(false);
  });

  it('neither field → explicit internal-admin system principal', () => {
    expect(principalOf({} as never)).toEqual(
      systemPrincipal(SYSTEM_CAPABILITIES.INTERNAL_ADMIN, 'internal (subject-less context)'),
    );
    expect(isSystemCtx({} as never)).toBe(true);
  });
});

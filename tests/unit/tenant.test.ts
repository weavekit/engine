import { describe, it, expect } from '../helpers/test.js';
import {
  SYSTEM_CAPABILITIES,
  principalScopeId,
  scopedKey,
  systemPrincipal,
  userPrincipal,
} from '../../src/core/index.js';
import { scopeOf } from '../../src/runtime/data-access/index.js';
import { withDefaultScope } from '../../src/adapters/auth/index.js';

describe('scope mechanics (W3.1)', () => {
  it('principalScopeId: user subject scope / system principal scope', () => {
    expect(principalScopeId(userPrincipal({ id: 'u1', roles: [], scopeId: 't1' }))).toBe('t1');
    expect(principalScopeId(userPrincipal({ id: 'u1', roles: [] }))).toBeUndefined();
    expect(principalScopeId(systemPrincipal(SYSTEM_CAPABILITIES.WORKFLOW_TIMER, 'timer', 't2'))).toBe('t2');
  });

  it('scopeOf: derives from the principal; ctx.scopeId overrides', () => {
    const ctx = { principal: userPrincipal({ id: 'u1', roles: [], scopeId: 't1' }) } as never;
    expect(scopeOf(ctx)).toBe('t1');
    expect(scopeOf({ ...(ctx as object), scopeId: 't9' } as never)).toBe('t9');
    expect(scopeOf({ principal: systemPrincipal(SYSTEM_CAPABILITIES.INTERNAL_ADMIN) } as never)).toBeUndefined();
  });

  it('scopedKey namespaces by scope; absent scope is unchanged', () => {
    expect(scopedKey('t1', 'calls')).toBe('t1:calls');
    expect(scopedKey(undefined, 'calls')).toBe('calls');
    expect(scopedKey('', 'calls')).toBe('calls');
  });

  it('withDefaultScope stamps a scope only when the subject lacks one', async () => {
    const plain = { resolve: async (h: string | undefined) => (h === 'Bearer x' ? { id: 'u1', roles: ['r'] } : null) };
    expect((await withDefaultScope(plain, 't1').resolve('Bearer x'))!.scopeId).toBe('t1');
    expect(await withDefaultScope(plain, 't1').resolve('nope')).toBeNull();
    const scoped = { resolve: async () => ({ id: 'u2', roles: [], scopeId: 't9' }) };
    expect((await withDefaultScope(scoped, 't1').resolve('Bearer y'))!.scopeId).toBe('t9');
  });
});

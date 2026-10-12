import { describe, it, expect } from '../helpers/test.js';
import {
  SYSTEM_CAPABILITIES,
  buildRlsPolicy,
  buildRowScope,
  principalScopeId,
  scopeFieldName,
  scopedKey,
  systemPrincipal,
  userPrincipal,
  type ObjectDefinition,
} from '../../src/core/index.js';
import { scopeOf } from '../../src/runtime/data-access/index.js';
import { withDefaultScope } from '../../src/adapters/auth/index.js';

function obj(): ObjectDefinition {
  return {
    name: 'thing',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'site_id', type: 'string', scope: true },
    ],
    permissions: { admin: { read: 'all' } },
  } as ObjectDefinition;
}

describe('row-scope (single `scope` marker)', () => {
  it('scopeFieldName recognizes the scope marker', () => {
    expect(scopeFieldName(obj())).toBe('site_id');
    expect(
      scopeFieldName({ name: 'x', fields: [{ name: 'id', type: 'string', primary: true }] } as ObjectDefinition),
    ).toBeUndefined();
  });

  it('principalScopeId / scopeOf resolve the scope', () => {
    expect(principalScopeId(userPrincipal({ id: 'u', roles: [], scopeId: 's1' }))).toBe('s1');
    expect(principalScopeId(systemPrincipal(SYSTEM_CAPABILITIES.INTERNAL_ADMIN))).toBeUndefined();
    const ctx = { principal: userPrincipal({ id: 'u', roles: [], scopeId: 's1' }) } as never;
    expect(scopeOf(ctx)).toBe('s1');
    expect(scopeOf({ ...(ctx as object), scopeId: 's9' } as never)).toBe('s9');
  });

  it('scopedKey namespaces by scope; absent scope is unchanged', () => {
    expect(scopedKey('s1', 'calls')).toBe('s1:calls');
    expect(scopedKey(undefined, 'calls')).toBe('calls');
  });

  it('withDefaultScope stamps a scope only when the subject lacks one', async () => {
    const plain = { resolve: async (h: string | undefined) => (h === 'Bearer x' ? { id: 'u1', roles: ['r'] } : null) };
    expect((await withDefaultScope(plain, 's1').resolve('Bearer x'))!.scopeId).toBe('s1');
    expect(await withDefaultScope(plain, 's1').resolve('nope')).toBeNull();
    const scoped = { resolve: async () => ({ id: 'u2', roles: [], scopeId: 's9' }) };
    expect((await withDefaultScope(scoped, 's1').resolve('Bearer y'))!.scopeId).toBe('s9');
  });

  it('buildRowScope scopes a scope-marked object by subject.scopeId', () => {
    const frag = buildRowScope(obj(), 'all', { id: 'u', roles: ['admin'], scopeId: 's1' }, ['admin']);
    expect(frag).toBeDefined();
    expect(frag!.params).toEqual(['s1']);
    expect(frag!.sql).toContain('"site_id" = $1');
  });

  it('buildRlsPolicy uses the weavekit.scope_id GUC', () => {
    expect(buildRlsPolicy(obj())).toContain("current_setting('weavekit.scope_id', true)");
  });
});

import { describe, it, expect } from '../helpers/test.js';
import {
  SYSTEM_CAPABILITIES,
  buildRlsPolicy,
  buildRowScope,
  principalScopeId,
  scopeFieldName,
  scopeMarkerOf,
  scopedKey,
  systemPrincipal,
  userPrincipal,
  type ObjectDefinition,
} from '../../src/core/index.js';
import { scopeOf } from '../../src/runtime/data-access/index.js';
import { withDefaultScope } from '../../src/adapters/auth/index.js';

function obj(marker: 'scope' | 'tenant'): ObjectDefinition {
  return {
    name: 'thing',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'site_id', type: 'string', [marker]: true } as never,
    ],
    permissions: { admin: { read: 'all' } },
  } as ObjectDefinition;
}

describe('row-scope generalization (G-ENG-2: scope alias)', () => {
  it('scopeFieldName / scopeMarkerOf recognize both markers', () => {
    expect(scopeFieldName(obj('scope'))).toBe('site_id');
    expect(scopeMarkerOf(obj('scope'))).toBe('scope');
    expect(scopeFieldName(obj('tenant'))).toBe('site_id');
    expect(scopeMarkerOf(obj('tenant'))).toBe('tenant');
    expect(scopeFieldName({ name: 'x', fields: [{ name: 'id', type: 'string', primary: true }] } as ObjectDefinition)).toBeUndefined();
  });

  it('principalScopeId / scopeOf resolve scopeId ?? tenantId', () => {
    expect(principalScopeId(userPrincipal({ id: 'u', roles: [], scopeId: 's1' }))).toBe('s1');
    expect(principalScopeId(userPrincipal({ id: 'u', roles: [], tenantId: 't1' }))).toBe('t1');
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
    // a tenantId also counts as carrying a scope
    const t = { resolve: async () => ({ id: 'u3', roles: [], tenantId: 't9' }) };
    expect((await withDefaultScope(t, 's1').resolve('Bearer z'))!.scopeId).toBeUndefined();
  });

  it('buildRowScope scopes a scope-marked object by subject.scopeId', () => {
    const frag = buildRowScope(obj('scope'), 'all', { id: 'u', roles: ['admin'], scopeId: 's1' }, ['admin']);
    expect(frag).toBeDefined();
    expect(frag!.params).toEqual(['s1']);
    expect(frag!.sql).toContain('"site_id" = $1');
  });

  it('buildRlsPolicy uses weavekit.scope_id for scope, tenant_id for the alias', () => {
    expect(buildRlsPolicy(obj('scope'))).toContain("current_setting('weavekit.scope_id', true)");
    expect(buildRlsPolicy(obj('tenant'))).toContain("current_setting('weavekit.tenant_id', true)");
  });
});

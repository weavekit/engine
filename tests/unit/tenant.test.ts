import { describe, it, expect } from '../helpers/test.js';
import {
  SYSTEM_CAPABILITIES,
  principalTenantId,
  scopedQuotaKey,
  systemPrincipal,
  userPrincipal,
} from '../../src/core/index.js';
import { tenantOf } from '../../src/runtime/data-access/index.js';
import { withDefaultTenant } from '../../src/adapters/auth/index.js';

describe('tenant mechanics (W3.1)', () => {
  it('principalTenantId: user subject tenant / system principal tenant', () => {
    expect(principalTenantId(userPrincipal({ id: 'u1', roles: [], tenantId: 't1' }))).toBe('t1');
    expect(principalTenantId(userPrincipal({ id: 'u1', roles: [] }))).toBeUndefined();
    expect(principalTenantId(systemPrincipal(SYSTEM_CAPABILITIES.WORKFLOW_TIMER, 'timer', 't2'))).toBe('t2');
  });

  it('tenantOf: derives from the principal; ctx.tenantId overrides', () => {
    const ctx = { principal: userPrincipal({ id: 'u1', roles: [], tenantId: 't1' }) } as never;
    expect(tenantOf(ctx)).toBe('t1');
    expect(tenantOf({ ...(ctx as object), tenantId: 't9' } as never)).toBe('t9');
    expect(tenantOf({ principal: systemPrincipal(SYSTEM_CAPABILITIES.INTERNAL_ADMIN) } as never)).toBeUndefined();
  });

  it('scopedQuotaKey namespaces by tenant; absent tenant is unchanged', () => {
    expect(scopedQuotaKey('t1', 'calls')).toBe('t1:calls');
    expect(scopedQuotaKey(undefined, 'calls')).toBe('calls');
    expect(scopedQuotaKey('', 'calls')).toBe('calls');
  });

  it('withDefaultTenant stamps a tenant only when the subject lacks one', async () => {
    const plain = { resolve: async (h: string | undefined) => (h === 'Bearer x' ? { id: 'u1', roles: ['r'] } : null) };
    expect((await withDefaultTenant(plain, 't1').resolve('Bearer x'))!.tenantId).toBe('t1');
    expect(await withDefaultTenant(plain, 't1').resolve('nope')).toBeNull();
    const scoped = { resolve: async () => ({ id: 'u2', roles: [], tenantId: 't9' }) };
    expect((await withDefaultTenant(scoped, 't1').resolve('Bearer y'))!.tenantId).toBe('t9');
  });
});

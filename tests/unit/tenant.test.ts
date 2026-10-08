import { describe, it, expect } from '../helpers/test.js';
import {
  SYSTEM_CAPABILITIES,
  principalTenantId,
  scopedQuotaKey,
  systemPrincipal,
  userPrincipal,
} from '../../src/core/index.js';
import { tenantOf } from '../../src/runtime/data-access/index.js';

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
});

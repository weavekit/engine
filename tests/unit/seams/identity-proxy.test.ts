import { describe, it, expect } from '../../helpers/test.js';
import { isAllowedProxyPath, type ProxyAllow } from '../../../src/core/index.js';
import type { IdentityStore } from '../../../src/core/provider/identity/index.js';
import { PgIdentityDirectory } from '../../../src/runtime/identity/directory.js';

/**
 * `IdentityStore` / `IdentityDirectory` and `ProxyTargetResolver` +
 * path-gate seam contracts.
 */

describe('IdentityDirectory seam contract', () => {
  const store = (row: unknown): IdentityStore => ({ findUser: async () => row }) as unknown as IdentityStore;

  it('resolves a known enabled user into a subject (departmentId included)', async () => {
    const dir = new PgIdentityDirectory(store({ id: 'u1', roles: ['r'], departmentId: 'd1', enabled: true }));
    expect(await dir.resolve('u1')).toEqual({ id: 'u1', roles: ['r'], departmentId: 'd1' });
  });

  it('unknown or disabled users resolve to null (fail-closed)', async () => {
    expect(await new PgIdentityDirectory(store(null)).resolve('ghost')).toBeNull();
    expect(await new PgIdentityDirectory(store({ id: 'u1', roles: [], enabled: false })).resolve('u1')).toBeNull();
  });
});

describe('Proxy path gate seam contract', () => {
  const allow: ProxyAllow = { read: ['api'], write: ['api/objects'] };

  it('GET is gated by `read`, other methods by `write`', () => {
    expect(isAllowedProxyPath('GET', 'api/objects/lead', allow)).toBe(true);
    expect(isAllowedProxyPath('GET', 'api', allow)).toBe(true);
    expect(isAllowedProxyPath('POST', 'api/objects/lead', allow)).toBe(true);
    expect(isAllowedProxyPath('POST', 'api/other', allow)).toBe(false); // not in write allow
    expect(isAllowedProxyPath('GET', 'api2', allow)).toBe(false);
  });

  it('unknown methods fall through to the (restrictive) write list', () => {
    expect(isAllowedProxyPath('BREW', 'api/objects/lead', allow)).toBe(true);
    expect(isAllowedProxyPath('BREW', 'api/readless', allow)).toBe(false);
  });

  it('rejects traversal / blank / encoded segments', () => {
    expect(isAllowedProxyPath('GET', 'api/../secret', allow)).toBe(false);
    expect(isAllowedProxyPath('GET', 'api//x', allow)).toBe(false);
    expect(isAllowedProxyPath('GET', 'api/x/./y', allow)).toBe(false);
    expect(isAllowedProxyPath('GET', 'api/%2e%2e', allow)).toBe(false);
    expect(isAllowedProxyPath('GET', 'api\\x', allow)).toBe(false);
  });
});

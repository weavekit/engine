import { describe, it, expect } from '../helpers/test.js';
import {
  DEFAULT_PROXY_ALLOW,
  isAllowedProxyPath,
  PROXY_KEY_SCOPES,
  PROXY_METHODS,
  type ProxyAllow,
} from '../../src/index.js';

const ALLOW = DEFAULT_PROXY_ALLOW;

describe('proxy types: isAllowedProxyPath', () => {
  it('allows a read path when it falls under a read prefix', () => {
    expect(isAllowedProxyPath('GET', '/audit', ALLOW)).toBe(true);
    expect(isAllowedProxyPath('GET', '/metadata/permissions', ALLOW)).toBe(true);
    // leading slash is tolerated
    expect(isAllowedProxyPath('GET', 'audit', ALLOW)).toBe(true);
    // trailing slash is tolerated
    expect(isAllowedProxyPath('GET', '/audit/', ALLOW)).toBe(true);
  });

  it('rejects a read path that is not under a read prefix', () => {
    expect(isAllowedProxyPath('GET', '/graphql', ALLOW)).toBe(false);
    expect(isAllowedProxyPath('GET', '/approvals-admin', ALLOW)).toBe(false);
  });

  it('allows object records under the default objects prefix', () => {
    expect(isAllowedProxyPath('GET', '/objects', ALLOW)).toBe(true);
    expect(isAllowedProxyPath('GET', '/objects/connections', ALLOW)).toBe(true);
    expect(isAllowedProxyPath('GET', '/objects/connections/records', ALLOW)).toBe(true);
    // the blanket `objects` prefix surfaces every object's records
    expect(isAllowedProxyPath('GET', '/objects/connections_log', ALLOW)).toBe(true);
  });

  it('matches a scoped object prefix at segment boundaries', () => {
    const scoped: ProxyAllow = { read: ['objects/connections'], write: [] };
    expect(isAllowedProxyPath('GET', '/objects/connections', scoped)).toBe(true);
    expect(isAllowedProxyPath('GET', '/objects/connections/records', scoped)).toBe(true);
    // a sibling object (and a substring-named one) is not matched
    expect(isAllowedProxyPath('GET', '/objects/projects', scoped)).toBe(false);
    expect(isAllowedProxyPath('GET', '/objects/connections_log', scoped)).toBe(false);
  });

  it('allows only write-prefixed paths for write methods', () => {
    expect(isAllowedProxyPath('POST', '/approvals/key/approve', ALLOW)).toBe(true);
    expect(isAllowedProxyPath('DELETE', '/approvals/key/approve', ALLOW)).toBe(true);
    // a read-only prefix is NOT writable through the generic proxy
    expect(isAllowedProxyPath('POST', '/audit', ALLOW)).toBe(false);
    expect(isAllowedProxyPath('PATCH', '/metadata', ALLOW)).toBe(false);
  });

  it('normalizes the method case (get → GET uses the read list)', () => {
    expect(isAllowedProxyPath('get', '/audit', ALLOW)).toBe(true);
    expect(isAllowedProxyPath('post', '/approvals/x', ALLOW)).toBe(true);
  });

  it('is case-sensitive on path prefix segments', () => {
    expect(isAllowedProxyPath('GET', '/Audit', ALLOW)).toBe(false);
    expect(isAllowedProxyPath('GET', '/AUDIT/foo', ALLOW)).toBe(false);
  });

  it('rejects path traversal and blank/duplicate segments', () => {
    expect(isAllowedProxyPath('GET', '/../etc', ALLOW)).toBe(false);
    expect(isAllowedProxyPath('GET', '/audit/../../etc', ALLOW)).toBe(false);
    expect(isAllowedProxyPath('GET', '/audit//x', ALLOW)).toBe(false);
    expect(isAllowedProxyPath('GET', '/audit/./x', ALLOW)).toBe(false);
    expect(isAllowedProxyPath('GET', '/audit/%2e%2e/x', ALLOW)).toBe(false);
    expect(isAllowedProxyPath('GET', '/audit/..%2fx', ALLOW)).toBe(false);
  });

  it('relaxes a single leading/trailing slash but not absolute/dup-slash', () => {
    expect(isAllowedProxyPath('GET', '//audit', ALLOW)).toBe(false);
  });

  it('uses the default allow set (read + write)', () => {
    // every default read prefix is actually proxied
    for (const p of ALLOW.read) {
      expect(isAllowedProxyPath('GET', `/${p}`, ALLOW)).toBe(true);
    }
    // a default write prefix accepts a write
    expect(isAllowedProxyPath('POST', '/approvals', ALLOW)).toBe(true);
    // out-of-set surface is denied
    expect(isAllowedProxyPath('GET', '/analytics/summary', ALLOW)).toBe(false);
  });

  it('is fail-closed: empty allowlists deny everything', () => {
    const empty = { read: [], write: [] };
    expect(isAllowedProxyPath('GET', '/audit', empty)).toBe(false);
    expect(isAllowedProxyPath('POST', '/approvals', empty)).toBe(false);
  });
});

describe('proxy types: constants', () => {
  it('PROXY_METHODS is a single-source as-const union', () => {
    expect(PROXY_METHODS).toEqual({
      GET: 'GET',
      POST: 'POST',
      PATCH: 'PATCH',
      PUT: 'PUT',
      DELETE: 'DELETE',
    });
  });

  it('PROXY_KEY_SCOPES constrains depth-2 writes to admin', () => {
    expect(PROXY_KEY_SCOPES).toEqual({ READ: 'read', ADMIN: 'admin' });
  });
});

import { describe, it, expect } from '../helpers/test.js';import { authenticate, buildAuthenticator, createAuth } from '../../src/adapters/auth/index.js';
import type { RbacSubject } from '../../src/core/rbac/index.js';
import { DEFAULT_LOCALE } from '../../src/core/index.js';

const admin: RbacSubject = { id: 'admin', roles: ['admin'] };

describe('auth source — static map', () => {
  it('Bearer key → subject', async () => {
    const auth = buildAuthenticator({ source: { 'sk-admin': admin } });
    expect(await auth.resolve('Bearer sk-admin')).toEqual(admin);
  });

  it('unknown key → null; missing header → null', async () => {
    const auth = createAuth({ source: { 'sk-admin': admin } });
    expect(await auth.resolve('Bearer nope')).toBeNull();
    expect(await auth.resolve(undefined)).toBeNull();
  });

  it('authenticate: missing header → auth.missingKey', async () => {
    const auth = buildAuthenticator({ source: { 'sk-admin': admin } });
    let threw: unknown;
    try {
      await authenticate(auth, undefined, DEFAULT_LOCALE);
    } catch (error) {
      threw = error;
    }
    expect((threw as { code?: string }).code).toBe('auth.missingKey');
  });

  it('authenticate: invalid key → auth.invalidKey', async () => {
    const auth = buildAuthenticator({ source: { 'sk-admin': admin } });
    let threw: unknown;
    try {
      await authenticate(auth, 'Bearer nope', DEFAULT_LOCALE);
    } catch (error) {
      threw = error;
    }
    expect((threw as { code?: string }).code).toBe('auth.invalidKey');
  });
});

describe('auth source — resolver function', () => {
  it('sync resolver takes effect (precedes map)', async () => {
    const auth = buildAuthenticator({
      source: (header) => (header === 'Bearer cust' ? { id: 'u1', roles: ['sales'] } : null),
    });
    expect(await auth.resolve('Bearer cust')).toEqual({ id: 'u1', roles: ['sales'] });
    expect(await auth.resolve('Bearer other')).toBeNull();
  });

  it('async resolver (simulates querying customer user table)', async () => {
    const table = new Map([
      ['Bearer tok-1', { id: 'u-alice', roles: ['sales'] }],
      ['Bearer tok-2', { id: 'u-alex', roles: ['manager'], teamId: 't1' }],
    ]);
    const auth = createAuth({
      source: async (header) => {
        await Promise.resolve();
        return table.get(header ?? '') ?? null;
      },
    });
    expect(await auth.resolve('Bearer tok-1')).toEqual({ id: 'u-alice', roles: ['sales'] });
    expect(await auth.resolve('Bearer tok-2')).toEqual({ id: 'u-alex', roles: ['manager'], teamId: 't1' });
    expect(await auth.resolve('Bearer nope')).toBeNull();
  });

  it('resolver receives full header (including Bearer prefix)', async () => {
    let seen: string | undefined;
    const auth = createAuth({
      source: (header) => {
        seen = header;
        return null;
      },
    });
    await auth.resolve('Bearer sk-xyz');
    expect(seen).toBe('Bearer sk-xyz');
  });

  it('async resolver succeeds and authenticate returns subject', async () => {
    const auth = buildAuthenticator({
      source: async (h) => (h === 'Bearer tok' ? { id: 'u1', roles: ['agent'] } : null),
    });
    const subject = await authenticate(auth, 'Bearer tok', DEFAULT_LOCALE);
    expect(subject.id).toBe('u1');
  });
});

import { describe, it, expect } from '../helpers/test.js';
import { DEFAULT_LOCALE, SchemaError } from '../../src/core/index.js';
import type { IdentityDirectory, IdentitySubject, VerifiedIdentity } from '../../src/core/provider/identity/index.js';
import { createDirectoryAuthenticator, enforceSyncedIdentity } from '../../src/adapters/auth/index.js';

const directoryOf = (subjects: Record<string, IdentitySubject>): IdentityDirectory => ({
  resolve: async (ref) => subjects[ref] ?? null,
});

describe('identity auth seam', () => {
  it('composes verifier → directory into a subject', async () => {
    const authenticator = createDirectoryAuthenticator({
      verifier: { verify: (h) => (h === 'Bearer ok' ? { ref: 'u1' } : null) },
      directory: directoryOf({ u1: { id: 'internal-1', roles: ['sales'], departmentId: 'd1' } }),
      locale: DEFAULT_LOCALE,
    });
    expect(await authenticator.resolve('Bearer ok')).toEqual({
      id: 'internal-1',
      roles: ['sales'],
      departmentId: 'd1',
    });
    // a bad credential → null (401 at the caller)
    expect(await authenticator.resolve('Bearer nope')).toBeNull();
    expect(await authenticator.resolve(undefined)).toBeNull();
  });

  it('rejects a verified-but-unsynced identity with identity.notSynced (fail-closed)', async () => {
    const authenticator = createDirectoryAuthenticator({
      verifier: { verify: () => ({ ref: 'ghost' }) },
      directory: directoryOf({}),
      locale: DEFAULT_LOCALE,
    });
    let caught: unknown;
    try {
      await authenticator.resolve('Bearer ok');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaError);
    expect((caught as SchemaError).code).toBe('identity.notSynced');
  });

  it('enforceSyncedIdentity gates any authenticator on the directory (roles from the directory)', async () => {
    const directory = directoryOf({ u1: { id: 'u1', roles: ['admin'], departmentId: 'd1' } });
    const inner = { resolve: async (h?: string): Promise<IdentitySubject | null> => (h === 'Bearer x' ? { id: 'u1', roles: ['stale'] } : null) };
    const gated = enforceSyncedIdentity(inner, directory, DEFAULT_LOCALE);
    // directory wins (authoritative roles)
    expect(await gated.resolve('Bearer x')).toEqual({ id: 'u1', roles: ['admin'], departmentId: 'd1' });

    const gatedMissing = enforceSyncedIdentity(
      { resolve: async (): Promise<IdentitySubject | null> => ({ id: 'ghost', roles: [] }) },
      directory,
      DEFAULT_LOCALE,
    );
    let caught: unknown;
    try {
      await gatedMissing.resolve('Bearer x');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SchemaError);
    expect((caught as SchemaError).code).toBe('identity.notSynced');
  });

  it('passes ref + claims from the verifier to the directory', async () => {
    let seen: { ref: string; claims?: Record<string, unknown> } | undefined;
    const verifier: { verify: (h?: string) => VerifiedIdentity | null } = {
      verify: () => ({ ref: 'u9', claims: { email: 'x@y' } }),
    };
    const directory: IdentityDirectory = {
      resolve: async (ref, claims) => {
        seen = { ref, claims };
        return { id: 'u9', roles: [] };
      },
    };
    await createDirectoryAuthenticator({ verifier, directory, locale: DEFAULT_LOCALE }).resolve('Bearer t');
    expect(seen).toEqual({ ref: 'u9', claims: { email: 'x@y' } });
  });
});

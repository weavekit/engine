import { describe, it, expect } from '../../helpers/test.js';
import { createAuth } from '../../../src/adapters/auth/index.js';
import type { AuthVerifier } from '../../../src/adapters/auth/index.js';
import type { VerifiedIdentity } from '../../../src/core/provider/identity/index.js';

/**
 * `AuthSource` / `Authenticator` / `AuthVerifier` seam contract. Enterprise E1
 * supplies a resolver or verifier; these guarantees must hold for any source.
 */

describe('AuthSource seam contract (static key map)', () => {
  const auth = createAuth({ source: { 'key-1': { id: 'u1', roles: ['sales'] } } });

  it('resolves a valid Bearer token (case-insensitive scheme)', async () => {
    expect((await auth.resolve('Bearer key-1'))?.id).toBe('u1');
    expect((await auth.resolve('bearer key-1'))?.id).toBe('u1');
  });

  it('rejects missing / malformed / unknown credentials with null (→ 401)', async () => {
    expect(await auth.resolve(undefined)).toBeNull();
    expect(await auth.resolve('key-1')).toBeNull(); // no scheme
    expect(await auth.resolve('Basic key-1')).toBeNull();
    expect(await auth.resolve('Bearer nope')).toBeNull();
  });

  it('does not resolve prototype keys (prototype-pollution guard)', async () => {
    expect(await auth.resolve('Bearer __proto__')).toBeNull();
    expect(await auth.resolve('Bearer constructor')).toBeNull();
  });
});

describe('AuthSource seam contract (custom resolver)', () => {
  it('passes the raw header through and supports async', async () => {
    const seen: Array<string | undefined> = [];
    const auth = createAuth({
      source: async (header) => {
        seen.push(header);
        return header === 'Bearer ok' ? { id: 'u9', roles: [] } : null;
      },
    });
    expect((await auth.resolve('Bearer ok'))?.id).toBe('u9');
    expect(await auth.resolve('Bearer no')).toBeNull();
    expect(seen).toEqual(['Bearer ok', 'Bearer no']);
  });
});

describe('AuthVerifier seam contract (contract only, E1 implements)', () => {
  it('a verifier returns a VerifiedIdentity or null', async () => {
    const verifier: AuthVerifier = {
      verify: async (header): Promise<VerifiedIdentity | null> =>
        header === 'Bearer jwt' ? { ref: 'ext-1', claims: {} } : null,
    };
    expect((await verifier.verify('Bearer jwt'))?.ref).toBe('ext-1');
    expect(await verifier.verify('Bearer nope')).toBeNull();
    expect(await verifier.verify(undefined)).toBeNull();
  });
});

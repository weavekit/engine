import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { describe, it, expect } from '../helpers/test.js';
import { createDirectoryAuthenticator, createOidcVerifier } from '../../src/adapters/auth/index.js';
import { LOCALES } from '../../src/core/index.js';

const ISSUER = 'https://idp.test';
const AUDIENCE = 'weavekit-engine';

/** a tiny in-memory JWKS + discovery endpoint served to the verifier's fetch */
function jwksFetch(jwks: { keys: JWK[] }): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.includes('/.well-known/openid-configuration')) {
      return new Response(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/jwks')) {
      return new Response(JSON.stringify(jwks), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

async function setup(): Promise<{
  verifier: (config?: Record<string, unknown>) => ReturnType<typeof createOidcVerifier>;
  sign: (claims: Record<string, unknown>, opts?: { exp?: string; aud?: string; alg?: string; kid?: string }) => Promise<string>;
}> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const fetchImpl = jwksFetch({ keys: [jwk] });
  return {
    verifier: (config = {}) =>
      createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE, ...(config as object) }, { fetch: fetchImpl }),
    sign: (claims, opts = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'test-key-1' })
        .setIssuer(ISSUER)
        .setAudience(opts.aud ?? AUDIENCE)
        .setSubject(typeof claims.sub === 'string' ? (claims.sub as string) : 'u-1')
        .setIssuedAt()
        .setExpirationTime(opts.exp ?? '5m')
        .sign(privateKey),
  };
}

describe('createOidcVerifier — built-in OIDC/JWT validation', () => {
  it('resolves a valid bearer token to its ref + claims', async () => {
    const { verifier, sign } = await setup();
    const token = await sign({ sub: 'u-1', roles: ['admin', 'sales'], tenant: 't1' }, {});
    const verified = await verifier({ subjectClaim: 'sub', rolesClaim: 'roles', tenantClaim: 'tenant' }).verify(`Bearer ${token}`);
    expect(verified?.ref).toBe('u-1');
    expect(verified?.claims?.roles).toEqual(['admin', 'sales']);
    expect(verified?.claims?.tenantId).toBe('t1');
  });

  it('rejects a missing header, non-bearer header, and garbage token', async () => {
    const { verifier } = await setup();
    expect(await verifier().verify(undefined)).toBeNull();
    expect(await verifier().verify('Basic abc')).toBeNull();
    expect(await verifier().verify('Bearer not-a-jwt')).toBeNull();
  });

  it('rejects wrong audience, wrong issuer, and expired tokens', async () => {
    const { verifier, sign } = await setup();
    expect(await verifier().verify(`Bearer ${await sign({ sub: 'u' }, { aud: 'other' })}`)).toBeNull();
    const wrongIssuer = await new SignJWT({ sub: 'u' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer('https://evil.test')
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign((await generateKeyPair('RS256')).privateKey);
    expect(await verifier().verify(`Bearer ${wrongIssuer}`)).toBeNull();
    expect(await verifier().verify(`Bearer ${await sign({ sub: 'u' }, { exp: '-1h' })}`)).toBeNull();
  });

  it('rejects a token whose signature does not match the JWKS key', async () => {
    const { verifier } = await setup();
    const { privateKey } = await generateKeyPair('RS256');
    const forged = await new SignJWT({ sub: 'u' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(privateKey);
    expect(await verifier().verify(`Bearer ${forged}`)).toBeNull();
  });

  it('discovers the JWKS from the issuer when jwksUri is omitted', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'disco-1';
    jwk.alg = 'RS256';
    const fetchImpl = jwksFetch({ keys: [jwk] });
    const verifier = createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE }, { fetch: fetchImpl });
    const token = await new SignJWT({ sub: 'u-9' })
      .setProtectedHeader({ alg: 'RS256', kid: 'disco-1' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(privateKey);
    expect((await verifier.verify(`Bearer ${token}`))?.ref).toBe('u-9');
  });

  it('requires issuer or jwksUri', () => {
    expect(() => createOidcVerifier({})).toThrow(/issuer.*jwksUri/);
  });

  it('composes with the identity directory (credential → verifier → directory → subject)', async () => {
    const { verifier, sign } = await setup();
    const directory = {
      resolve: async (ref: string): Promise<{ id: string; roles: string[] } | null> =>
        ref === 'u-1' ? { id: 'u-1', roles: ['admin'] } : null,
    };
    const authenticator = createDirectoryAuthenticator({ verifier: verifier(), directory, locale: LOCALES.EN });
    expect(await authenticator.resolve(`Bearer ${await sign({ sub: 'u-1' })}`)).toEqual({ id: 'u-1', roles: ['admin'] });
    expect(await authenticator.resolve(undefined)).toBeNull();
  });
});

import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { VerifiedIdentity } from '../../core/provider/identity/index.js';
import type { AuthVerifier } from './verify.js';

/**
 * Built-in OIDC/JWT bearer verification (MIT). The engine ships this verifier so
 * a project can authenticate with a standards-based IdP (JWKS + local JWT
 * validation) without an integration. It resolves a `Bearer <jwt>` into a
 * {@link VerifiedIdentity} (`ref` from {@link OidcConfig.subjectClaim}, default
 * `sub`); the identity directory then maps it to an `IdentitySubject`.
 *
 * Signature/JWKS handling is delegated to `jose` (`createRemoteJWKSet` caches and
 * rotates keys by `kid`). Configure it under `EngineConfig.auth.oidc`.
 */
export interface OidcConfig {
  /**
   * OIDC issuer. Used as the `iss` check and, unless `jwksUri` is set, to
   * discover the JWKS at `<issuer>/.well-known/openid-configuration`.
   */
  issuer?: string;
  /** explicit JWKS endpoint; overrides discovery (required when `issuer` is unset) */
  jwksUri?: string;
  /** expected `aud` (string or list); the token's `aud` must include it */
  audience?: string | string[];
  /** claim carrying the external user ref (default `sub`) */
  subjectClaim?: string;
  /** when set, the named claim's value is also exposed as `claims.roles` */
  rolesClaim?: string;
  /** when set, the named claim's value is also exposed as `claims.tenantId` */
  tenantClaim?: string;
  /** allowed signing algorithms (default: asymmetric RS/ES/PS/EdDSA — never `none`/HMAC) */
  algorithms?: string[];
  /** clock-skew tolerance in seconds (default 5) */
  clockToleranceSec?: number;
  /** OAuth authorization server(s) advertised at `/.well-known/oauth-protected-resource` (default: `[issuer]`) */
  authorizationServers?: string[];
  /** scopes advertised in the protected-resource metadata */
  scopes?: string[];
  /** this server's public URL (the metadata `resource`); defaults to the request origin */
  resource?: string;
}

/** asymmetric algorithms only — symmetric/HMAC/`none` are never accepted */
const DEFAULT_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'ES256',
  'ES384',
  'ES512',
  'PS256',
  'PS384',
  'PS512',
  'EdDSA',
];

/** extract the token from a `Bearer <jwt>` Authorization header */
function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/** a string claim value (arrays/objects are ignored) */
function stringClaim(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === 'string' ? value : undefined;
}

export interface OidcVerifierOptions {
  /** fetch implementation (defaults to the global `fetch`); injectable for tests */
  fetch?: typeof fetch;
}

/**
 * Build an {@link AuthVerifier} that locally validates OIDC JWTs. Returns `null`
 * (→ 401 `auth.invalidKey`) for a missing/invalid token, never throws on a bad
 * credential. The JWKS is fetched lazily on the first verification.
 */
export function createOidcVerifier(config: OidcConfig, options: OidcVerifierOptions = {}): AuthVerifier {
  if (config.issuer === undefined && config.jwksUri === undefined) {
    throw new Error('auth.oidc: set "issuer" (discovery) or "jwksUri"');
  }
  const algorithms = config.algorithms ?? DEFAULT_ALGORITHMS;
  const fetchImpl = options.fetch ?? fetch;
  let keySet: JWTVerifyGetKey | undefined;

  async function keys(): Promise<JWTVerifyGetKey> {
    if (keySet !== undefined) return keySet;
    let uri = config.jwksUri;
    if (uri === undefined) {
      const discoveryUrl = `${config.issuer!.replace(/\/$/, '')}/.well-known/openid-configuration`;
      const res = await fetchImpl(discoveryUrl);
      if (!res.ok) throw new Error(`auth.oidc: discovery failed (${res.status}) for ${discoveryUrl}`);
      const doc = (await res.json()) as { jwks_uri?: unknown };
      if (typeof doc.jwks_uri !== 'string') throw new Error('auth.oidc: discovery document has no jwks_uri');
      uri = doc.jwks_uri;
    }
    keySet = createRemoteJWKSet(new URL(uri), { [customFetch]: fetchImpl });
    return keySet;
  }

  return {
    async verify(header: string | undefined): Promise<VerifiedIdentity | null> {
      const token = bearerToken(header);
      if (token === undefined) return null;
      let payload: JWTPayload;
      try {
        const result = await jwtVerify(token, await keys(), {
          ...(config.issuer === undefined ? {} : { issuer: config.issuer }),
          ...(config.audience === undefined ? {} : { audience: config.audience }),
          algorithms,
          clockTolerance: config.clockToleranceSec ?? 5,
        });
        payload = result.payload;
      } catch {
        return null; // invalid signature/claims → unauthenticated
      }
      const ref = stringClaim(payload, config.subjectClaim ?? 'sub');
      if (ref === undefined || ref === '') return null;
      const claims: Record<string, unknown> = { ...payload };
      if (config.rolesClaim !== undefined && claims.roles === undefined) {
        const roles = payload[config.rolesClaim];
        if (roles !== undefined) claims.roles = roles;
      }
      if (config.tenantClaim !== undefined && claims.tenantId === undefined) {
        const tenant = stringClaim(payload, config.tenantClaim);
        if (tenant !== undefined) claims.tenantId = tenant;
      }
      return { ref, claims };
    },
  };
}

import type { VerifiedIdentity } from '../../core/provider/identity/index.js';

/**
 * Authentication seam: turn a raw credential (the `Authorization` header) into
 * a verified-but-unresolved identity. Protocol verifiers (OIDC/JWT/SAML) are
 * supplied by integrations (e.g. `@weave-kit/enterprise`); the engine defines
 * the contract and composes it with the identity directory. Returning `null`
 * means the credential is missing/invalid (401).
 */
export interface AuthVerifier {
  verify(header: string | undefined): VerifiedIdentity | null | Promise<VerifiedIdentity | null>;
}

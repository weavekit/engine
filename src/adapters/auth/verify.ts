import type { VerifiedIdentity } from '../../core/provider/identity/index.js';

/**
 * Authentication seam: turn a raw credential (the `Authorization` header) into
 * a verified-but-unresolved identity. The engine ships a built-in OIDC/JWT
 * verifier (`createOidcVerifier`, configured via `auth.oidc`); other protocol
 * verifiers (SAML, …) are supplied by integrations (e.g. `@weave-kit/enterprise`)
 * against this same contract. Returning `null` means the credential is
 * missing/invalid (401).
 *
 * Stable seam (`@enterprise-reserved`): SAML and other protocol verifiers are
 * enterprise E1; OIDC/JWT is MIT.
 */
export interface AuthVerifier {
  verify(header: string | undefined): VerifiedIdentity | null | Promise<VerifiedIdentity | null>;
}

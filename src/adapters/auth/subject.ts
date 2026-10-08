import type { Locale } from '../../core/index.js';
import { SchemaError } from '../../core/index.js';
import type { IdentityDirectory, IdentitySubject } from '../../core/provider/identity/index.js';
import type { Authenticator } from './source.js';
import type { AuthVerifier } from './verify.js';

/**
 * Compose credential verification with the identity directory:
 * `credential → (AuthVerifier) → VerifiedIdentity → (IdentityDirectory) → IdentitySubject`.
 * A verified credential whose user is not provisioned locally is rejected with
 * `identity.notSynced` (provision with `weave sync:identity` first).
 */
export function createDirectoryAuthenticator(options: {
  verifier: AuthVerifier;
  directory: IdentityDirectory;
  locale: Locale;
}): Authenticator {
  const { verifier, directory, locale } = options;
  return {
    async resolve(header: string | undefined): Promise<IdentitySubject | null> {
      const verified = await verifier.verify(header);
      if (verified === null) return null;
      const subject = await directory.resolve(verified.ref, verified.claims);
      if (subject === null) {
        throw new SchemaError('identity.notSynced', { ref: verified.ref }, locale);
      }
      return subject;
    },
  };
}

/**
 * Gate any authenticator on the local directory: the resolved subject must have
 * a synced local user, and RBAC then uses the directory's authoritative
 * roles/department. Unknown identities are rejected with `identity.notSynced`.
 */
export function enforceSyncedIdentity(
  inner: Authenticator,
  directory: IdentityDirectory,
  locale: Locale,
): Authenticator {
  return {
    async resolve(header: string | undefined): Promise<IdentitySubject | null> {
      const subject = await inner.resolve(header);
      if (subject === null) return null;
      const synced = await directory.resolve(subject.id);
      if (synced === null) {
        throw new SchemaError('identity.notSynced', { ref: subject.id }, locale);
      }
      return synced;
    },
  };
}

/**
 * Multi-tenancy: decorate an authenticator so a resolved subject without a
 * tenant is stamped with the configured default tenant (row-mode single-tenant
 * deployments). A subject that already carries a tenant is left untouched.
 */
export function withDefaultTenant(inner: Authenticator, defaultTenant: string): Authenticator {
  return {
    async resolve(header: string | undefined): Promise<IdentitySubject | null> {
      const subject = await inner.resolve(header);
      if (subject === null || subject.tenantId !== undefined) return subject;
      return { ...subject, tenantId: defaultTenant };
    },
  };
}

import type { Locale } from '../../core/index.js';
import { SchemaError } from '../../core/index.js';
import type { RbacSubject } from '../../core/index.js';
import { createAuth, type AuthConfig, type Authenticator } from './source.js';

export type { Authenticator, AuthConfig, AuthResolver, AuthSource } from './source.js';
export { createAuth } from './source.js';

/**
 * Resolve the Authorization header into a subject, or throw a 401-family
 * {@link SchemaError}. Missing header → `auth.missingKey`; present but
 * unresolvable → `auth.invalidKey`. The REST layer maps both to 401.
 */
export async function authenticate(
  authenticator: Authenticator,
  header: string | undefined,
  locale: Locale,
): Promise<RbacSubject> {
  const subject = await authenticator.resolve(header);
  if (subject !== null) return subject;
  if (header === undefined) throw new SchemaError('auth.missingKey', {}, locale);
  throw new SchemaError('auth.invalidKey', {}, locale);
}

/** build the default authenticator from an auth source (static map or custom resolver) */
export function buildAuthenticator(config: AuthConfig): Authenticator {
  return createAuth(config);
}

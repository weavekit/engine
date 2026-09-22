import type { RbacSubject } from '../../core/index.js';

/** resolves an Authorization header into an authenticated identity (null = unauthenticated) */
export interface Authenticator {
  resolve(header: string | undefined): RbacSubject | null | Promise<RbacSubject | null>;
}

/**
 * Custom auth resolver: given the raw Authorization header (including the
 * `Bearer ` prefix), return the authenticated subject. Async resolvers may load
 * the user from the customer's own database / verify a JWT. Returning null
 * means unauthenticated (401).
 */
export type AuthResolver = (header: string | undefined) => RbacSubject | null | Promise<RbacSubject | null>;

/**
 * The authentication source: either a static key map or a resolver function.
 * `source` is required whenever `auth` is configured (fail fast otherwise).
 */
export type AuthSource = Record<string, RbacSubject> | AuthResolver;

/** authentication config — the single source of truth is `source` */
export interface AuthConfig {
  source: AuthSource;
}

/** default authenticator: static map (unchanged behavior) or custom resolver */
export function createAuth(config: AuthConfig): Authenticator {
  const source = config.source;
  if (typeof source === 'function') {
    return { resolve: (header) => source(header) };
  }
  const keys = source;
  return {
    resolve(header: string | undefined): RbacSubject | null {
      if (header === undefined) return null;
      const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
      if (match === null) return null;
      const token = match[1]!;
      // own-property check: a token like `__proto__`/`constructor` must not
      // resolve through the prototype chain to a non-subject value
      return Object.hasOwn(keys, token) ? (keys[token] ?? null) : null;
    },
  };
}

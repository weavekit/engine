import type { OidcConfig } from './oidc.js';

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728) + the `WWW-Authenticate`
 * challenge that points an MCP host at it. When `auth.oidc` is configured the
 * engine advertises its authorization server(s) at
 * `/.well-known/oauth-protected-resource`, and 401 responses carry a
 * `Bearer resource_metadata="…"` challenge so a standards-based MCP host (Claude,
 * ChatGPT connectors, VS Code) can discover and run the OAuth flow.
 */
export const OAUTH_PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

export interface OAuthProtectedResourceMetadata {
  /** this protected resource's identifier (the MCP server URL) */
  resource: string;
  /** OAuth authorization server issuer(s) an agent obtains a token from */
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported?: string[];
}

/** build the RFC 9728 metadata; `undefined` when OIDC is not configured */
export function oauthProtectedResourceMetadata(
  oidc: OidcConfig | undefined,
  origin: string,
): OAuthProtectedResourceMetadata | undefined {
  if (oidc === undefined) return undefined;
  const authorizationServers = oidc.authorizationServers ?? (oidc.issuer === undefined ? [] : [oidc.issuer]);
  return {
    resource: oidc.resource ?? origin,
    authorization_servers: authorizationServers,
    bearer_methods_supported: ['header'],
    ...(oidc.scopes === undefined ? {} : { scopes_supported: oidc.scopes }),
  };
}

/** the RFC 9728 `WWW-Authenticate` challenge for a 401 (points at the metadata document) */
export function wwwAuthenticateChallenge(origin: string): string {
  return `Bearer resource_metadata="${origin}${OAUTH_PROTECTED_RESOURCE_PATH}"`;
}

import { createHash } from 'node:crypto';
import type { IdentitySubject } from '../../core/index.js';

/**
 * Stable, non-secret identifier for the agent credential that presented a
 * request: a SHA-256 fingerprint of the raw Bearer token. The raw secret is
 * never stored on the session or written to the audit log — this fingerprint
 * binds a session to the exact credential that established it and keys
 * per-agent rate limits / audit rows.
 */
export function credentialIdOf(authorization: string | undefined): string {
  const token = typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/i, '').trim() : '';
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Session model for the MCP adapter. A session is established at the first
 * `initialize` handshake: the agent's API-key subject is authenticated at the
 * HTTP layer and the proxied user identity is bound from the
 * `X-Weavekit-On-Behalf-Of` header. `tools/list` filters the tool surface by
 * `user`, and `tools/call` enforces RBAC against `user` (double layer).
 */
export interface McpSession {
  /** SDK transport session id (from the Mcp-Session-Id header) */
  id: string;
  /** fingerprint of the agent credential that established the session (binding + rate limit key) */
  agentCredentialId: string;
  /** agent subject from the Bearer key (authenticator.resolve) */
  agentSubject: IdentitySubject;
  /** proxied user identity the agent acts on behalf of (RBAC decisions use this) */
  user: IdentitySubject;
  /** the on-behalf-of reference this session was bound with */
  onBehalfOf: string;
  createdAt: Date;
  lastActivity: Date;
}

export interface SessionInput {
  agentCredentialId: string;
  agentSubject: IdentitySubject;
  user: IdentitySubject;
  onBehalfOf: string;
}

/** default TTL: sessions idle for this long are dropped lazily */
export const SESSION_TTL_MS = 30 * 60 * 1000;

/**
 * In-memory session store keyed by SDK session id. TTL expiry is lazy: `get`
 * drops the entry when the last activity is older than the TTL, so no timer is
 * required. `dispose` clears everything (used by engine.close()).
 */
export class McpSessionStore {
  private readonly sessions = new Map<string, McpSession>();

  create(id: string, input: SessionInput, now: Date = new Date()): McpSession {
    const session: McpSession = {
      id,
      ...input,
      createdAt: now,
      lastActivity: now,
    };
    this.sessions.set(id, session);
    return session;
  }

  /** look up a session, refreshing `lastActivity`; undefined when unknown or expired */
  get(id: string, now: Date = new Date()): McpSession | undefined {
    const session = this.sessions.get(id);
    if (session === undefined) return undefined;
    if (now.getTime() - session.lastActivity.getTime() > SESSION_TTL_MS) {
      this.sessions.delete(id);
      return undefined;
    }
    session.lastActivity = now;
    return session;
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  /** all live sessions (used for shutdown cleanup) */
  list(): McpSession[] {
    return [...this.sessions.values()];
  }

  dispose(): void {
    this.sessions.clear();
  }
}

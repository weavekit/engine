import type { RbacSubject } from '../rbac/types.js';

/**
 * Single source of truth for the engine generic proxy vocabulary. This module is
 * pure types + static validation (`isAllowedProxyPath`); it carries no network
 * or IO concerns — outbound fetch and routing live in `runtime/proxy` and
 * `adapters/rest`.
 *
 * Security posture: the proxy is opened by path-prefix allowlist (`ProxyAllow`),
 * NOT by enumerating engine resources, so new engine/business REST surfaces can
 * be proxied by widening the allowlist instead of touching the routes.
 */

/** HTTP methods the proxy is allowed to forward. */
export const PROXY_METHODS = {
  GET: 'GET',
  POST: 'POST',
  PATCH: 'PATCH',
  PUT: 'PUT',
  DELETE: 'DELETE',
} as const;
export type ProxyMethod = typeof PROXY_METHODS[keyof typeof PROXY_METHODS];

/** connection key scopes; depth-2 writes (approvals) require `admin`. */
export const PROXY_KEY_SCOPES = {
  READ: 'read',
  ADMIN: 'admin',
} as const;
export type ProxyKeyScope = typeof PROXY_KEY_SCOPES[keyof typeof PROXY_KEY_SCOPES];

/**
 * Path-prefix allowlist for the generic proxy (fail-closed). Each entry is a
 * leading segment set; a request is allowed when its path (normalized to
 * segments) begins with one of the listed prefixes.
 */
export interface ProxyAllow {
  /** read prefixes (GET). Default `['audit','metadata','permissions','identities','guardrails','approvals','events','objects']`. */
  read: string[];
  /** write prefixes (POST/PATCH/PUT/DELETE). Default `['approvals']`; writes also require `keyScope=admin` + subject admin. */
  write: string[];
}

/** Canonical default allowlist (single source of truth; assembly merges a `Partial<ProxyAllow>` onto this). */
export const DEFAULT_PROXY_ALLOW: ProxyAllow = {
  read: ['audit', 'metadata', 'permissions', 'identities', 'guardrails', 'approvals', 'events', 'objects'],
  write: ['approvals'],
};

/**
 * A resolvable remote (customer engine) — injected by the application layer
 * (agent-gov). `id` is the customer-engine connection id and doubles as the
 * `:instance` route segment; documented distinctly from the governance app
 * "instance" to avoid confusion.
 */
export interface ProxyTarget {
  /** = `:instance` = customer-engine connection id (`connections.id`). */
  id: string;
  /** customer-engine base URL (used for `direct`; opaque for `tunnel`/`cloud`). */
  url: string;
  /** how the target is reached: `direct` (url) | `tunnel` (HTTP/2 connector) | `cloud` (in-cloud app instance). Forwarder uses `url` today; transport-aware routing is P1. */
  transport?: string;
  /** read/admin key (the application layer reads it from the connection). */
  apiKey: string;
  /** depth-2 writes need `admin`. */
  keyScope?: ProxyKeyScope;
  /** per-instance allowlist override (app layer reads it from the connection's
   * `proxy_allow`). When absent, the route falls back to the boot-time allow —
   * so a connection that doesn't set one inherits the engine default. */
  allow?: ProxyAllow;
  labels?: Record<string, string>;
}

/** A proxied request spec: method/path/query/body, forwarded to the target `{url}/api/{path}`. */
export interface ProxyRequest {
  instance: string;
  method: ProxyMethod;
  /** relative engine REST path (must pass `isAllowedProxyPath`). */
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** extra upstream header passthrough (e.g. `last-event-id` for SSE replay). `authorization` stays authoritative. */
  headers?: Record<string, string>;
}

/** Proxy response — target status code + serialized JSON body. */
export interface ProxyResponse {
  status: number;
  body: unknown;
}

/**
 * Narrow injection seam so core never depends on the application layer: the
 * engine doesn't parse connections or read tables, it only trusts this resolver.
 * The application layer (agent-gov) implements it from its own `connections`.
 */
export interface ProxyTargetResolver {
  /** Resolve a target by instance; `null` when unregistered (→ 404). Whoever can access which connection is the app's call. */
  resolve(instance: string, subject: RbacSubject): Promise<ProxyTarget | null>;
  /** Optional: list targets the subject may reach (for `GET /api/proxy`). */
  list?(subject: RbacSubject): Promise<ProxyTarget[]>;
}

/** Normalize + validate a path into segments; `null` when unsafe (traversal/absolute/dup-slash). */
function safeSegments(raw: string): string[] | null {
  if (raw.includes('\\') || raw.includes('%')) return null;
  let p = raw.startsWith('/') ? raw.slice(1) : raw;
  if (p.endsWith('/')) p = p.slice(0, -1);
  if (p.length === 0) return [];
  const segs = p.split('/');
  const out: string[] = [];
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return null;
    out.push(s);
  }
  return out;
}

/**
 * Pure gate: is `method`+`path` within an `allow` prefix? GET → `read`, every
 * other method → `write`. Path is normalized to segments (leading/trailing slash
 * tolerated), compared case-sensitively, and traversal/blank segments are
 * rejected. Unknown methods fall through to the (restrictor) write list.
 *
 * Tested across: read/write prefix, case sensitivity, path traversal, unknown
 * path & the default allow set.
 */
export function isAllowedProxyPath(method: string, path: string, allow: ProxyAllow): boolean {
  const segs = safeSegments(path);
  if (!segs) return false;
  const list = method.toUpperCase() === PROXY_METHODS.GET ? allow.read : allow.write;
  return list.some((prefix) => {
    const pre = safeSegments(prefix);
    if (!pre || pre.length > segs.length) return false;
    for (let i = 0; i < pre.length; i += 1) {
      if (pre[i] !== segs[i]) return false;
    }
    return true;
  });
}

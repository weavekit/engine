import { SchemaError } from '../../core/index.js';
import type { Locale, RbacSubject } from '../../core/index.js';
import type { SlidingWindow } from '../../core/limiter/index.js';
import { authenticate, type Authenticator } from '../auth/index.js';

/** raw API key from the Authorization header (rate-limit key, mirrors MCP) */
export function rateKey(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match === null ? undefined : match[1];
}

/** enforce the sliding window for a request; throws 429 when exceeded */
export function checkRateLimit(
  limiter: SlidingWindow | undefined,
  request: { headers: { authorization?: string } },
  locale: Locale,
): void {
  if (limiter === undefined) return;
  const key = rateKey(request.headers.authorization) ?? '(none)';
  if (!limiter.check(key)) {
    throw new SchemaError('http.rateLimited', {}, locale);
  }
}

/** authenticate a request against the auth source (401 on missing/invalid key) */
export async function authenticateRequest(
  authenticator: Authenticator,
  request: { headers: { authorization?: string } },
  locale: Locale,
): Promise<RbacSubject> {
  return authenticate(authenticator, request.headers.authorization, locale);
}

/**
 * Fail-closed admin gate: the subject must carry at least one
 * role listed in `adminRoles`. Used for admin-only source routes (server
 * scripts, raw schema, layout writes, page lifecycle).
 */
export function requireAdmin(
  roles: string[],
  resource: string,
  adminRoles: string[] | undefined,
  locale: Locale,
): void {
  const admin = new Set(adminRoles ?? []);
  if (!roles.some((role) => admin.has(role))) {
    throw new SchemaError('rbac.denied.update', { object: resource, role: roles.join(',') }, locale);
  }
}

/** read a string query param; non-string → http.param.invalid */
export function readString(query: Record<string, unknown>, key: string, locale: Locale): string | undefined {
  const v = query[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new SchemaError('http.param.invalid', { param: key }, locale);
  return v;
}

/** read an ISO date query param; unparsable → http.param.invalid */
export function readDate(query: Record<string, unknown>, key: string, locale: Locale): Date | undefined {
  const v = readString(query, key, locale);
  if (v === undefined) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new SchemaError('http.param.invalid', { param: key }, locale);
  return d;
}

/** read an integer query param; non-integer → http.param.invalid */
export function readInt(query: Record<string, unknown>, key: string, locale: Locale): number | undefined {
  const v = readString(query, key, locale);
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) throw new SchemaError('http.param.invalid', { param: key }, locale);
  return Number(v);
}

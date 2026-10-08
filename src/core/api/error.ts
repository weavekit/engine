import { DEFAULT_LOCALE, translate, type Locale, type MessageKey } from '../i18n/index.js';
import { SchemaError } from '../types/errors.js';
import type { ApiErrorBody, ApiErrorSpec } from './types.js';

/** message keys that map to 401 Unauthorized */
const UNAUTHORIZED = new Set<MessageKey>(['auth.missingKey', 'auth.invalidKey', 'ingress.unauthorized']);

/** message keys that map to 403 Forbidden */
const FORBIDDEN = new Set<MessageKey>([
  'rbac.denied.read',
  'rbac.denied.create',
  'rbac.denied.update',
  'rbac.denied.delete',
  'rbac.denied.field',
  'rbac.departmentId.missing',
  'script.query.denied',
  'audit.denied.actor',
  'proxy.denied',
  'workflow.transition.denied',
  'identity.notSynced',
  'rbac.scope.columnMissing',
]);

/** message keys that map to 404 Not Found */
const NOT_FOUND = new Set<MessageKey>(['data.recordNotFound', 'data.objectUnknown', 'http.notFound', 'approval.notFound', 'proxy.notFound', 'workflow.transition.unknown']);

/** message keys that map to 409 Conflict (optimistic locking / reference protection) */
const CONFLICT = new Set<MessageKey>(['data.unique', 'http.conflict', 'source.versionMismatch', 'page.exists', 'page.ref.inUse', 'workflow.transition.notAllowed', 'workflow.transition.pending']);

/** message keys that map to 429 Too Many Requests */
const RATE_LIMITED = new Set<MessageKey>(['http.rateLimited', 'quota.exceeded']);

/**
 * message keys that map to 500 — server-side faults (not the caller's request).
 * Everything else defaults to 400: the `SchemaError` code space is dominated by
 * request conditions (bad params/fields, RBAC denials, not-found), so a code the
 * engine forgot to categorize must not masquerade as an internal error.
 */
const SERVER_ERROR = new Set<MessageKey>([
  'http.internal',
  'data.schemaDrift',
  'script.timeout',
  'script.busy',
  'script.compile',
  'script.sandbox.unavailable',
]);

function errorBody(code: MessageKey, message: string, params: Record<string, unknown>): ApiErrorBody {
  return { error: { code, message, params } };
}

/**
 * Map any thrown value to a uniform HTTP error spec.
 * - {@link SchemaError} → status by message-key category (unknown categories
 *   default to 400), message re-rendered in the error's locale (JSON/API layer
 *   stays i18n-aware)
 * - everything else → 500 (no internals leak)
 */
export function mapSchemaError(err: unknown, locale?: Locale): ApiErrorSpec {
  if (err instanceof SchemaError) {
    const code = err.code;
    let status = 400;
    if (UNAUTHORIZED.has(code)) status = 401;
    else if (FORBIDDEN.has(code)) status = 403;
    else if (NOT_FOUND.has(code)) status = 404;
    else if (CONFLICT.has(code)) status = 409;
    else if (RATE_LIMITED.has(code)) status = 429;
    else if (SERVER_ERROR.has(code)) status = 500;
    else if (code === 'proxy.timeout') status = 504; // upstream gateway timeout
    else if (code.startsWith('proxy.')) status = 502; // upstream unreachable / too large
    return { status, body: errorBody(code, err.localize(locale ?? err.locale), err.params) };
  }
  const status = (err as { statusCode?: number } | null)?.statusCode;
  if (status !== undefined && status >= 400 && status < 500) {
    const body: ApiErrorBody = {
      error: { code: 'http.param.invalid', message: translate('http.param.invalid', { param: 'body' }, locale ?? DEFAULT_LOCALE) },
    };
    return { status, body };
  }
  return { status: 500, body: errorBody('http.internal', translate('http.internal', {}, locale ?? DEFAULT_LOCALE), {}) };
}

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
  'rbac.teamId.missing',
  'script.query.denied',
  'audit.denied.actor',
  'proxy.denied',
]);

/** message keys that map to 404 Not Found */
const NOT_FOUND = new Set<MessageKey>(['data.recordNotFound', 'data.objectUnknown', 'http.notFound', 'approval.notFound', 'proxy.notFound']);

/** message keys that map to 409 Conflict (optimistic locking / reference protection) */
const CONFLICT = new Set<MessageKey>(['data.unique', 'http.conflict', 'source.versionMismatch', 'page.exists', 'page.ref.inUse']);

/** message keys that map to 429 Too Many Requests */
const RATE_LIMITED = new Set<MessageKey>(['http.rateLimited', 'quota.exceeded']);

/** message keys that map to 400 Bad Request */
const BAD_REQUEST = new Set<MessageKey>(['script.abort', 'schema.version.unsupported']);

function errorBody(code: MessageKey, message: string, params: Record<string, unknown>): ApiErrorBody {
  return { error: { code, message, params } };
}

/**
 * Map any thrown value to a uniform HTTP error spec.
 * - {@link SchemaError} → status by message-key category, message re-rendered
 *   in the error's locale (JSON/API layer stays i18n-aware)
 * - everything else → 500 (no internals leak)
 */
export function mapSchemaError(err: unknown, locale?: Locale): ApiErrorSpec {
  if (err instanceof SchemaError) {
    const code = err.code;
    let status = 500;
    if (UNAUTHORIZED.has(code)) status = 401;
    else if (FORBIDDEN.has(code)) status = 403;
    else if (NOT_FOUND.has(code)) status = 404;
    else if (CONFLICT.has(code)) status = 409;
    else if (RATE_LIMITED.has(code)) status = 429;
    else if (BAD_REQUEST.has(code)) status = 400;
    else if (code === 'data.schemaDrift') status = 500; // server-side schema/DB drift
    else if (code === 'proxy.timeout') status = 504; // upstream gateway timeout
    else if (code.startsWith('proxy.')) status = 502; // upstream unreachable / too large
    else if (
      code.startsWith('data.') ||
      code.startsWith('http.') ||
      code.startsWith('mcp.') ||
      code.startsWith('layout.') ||
      code.startsWith('page.')
    ) {
      status = 400;
    }
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

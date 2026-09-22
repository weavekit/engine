import { describe, it, expect } from '../helpers/test.js';
import { mapSchemaError } from '../../src/core/api/index.js';
import { SchemaError } from '../../src/core/index.js';
import type { MessageKey } from '../../src/core/i18n/index.js';

/** message-key → expected HTTP status (see core/api/error.ts) */
const CASES: Array<[MessageKey, number]> = [
  // 401
  ['auth.missingKey', 401],
  ['auth.invalidKey', 401],
  ['ingress.unauthorized', 401],
  // 403
  ['rbac.denied.read', 403],
  ['rbac.denied.field', 403],
  ['rbac.teamId.missing', 403],
  ['script.query.denied', 403],
  ['audit.denied.actor', 403],
  ['proxy.denied', 403],
  // 404
  ['data.recordNotFound', 404],
  ['data.objectUnknown', 404],
  ['http.notFound', 404],
  ['approval.notFound', 404],
  ['proxy.notFound', 404],
  // 409
  ['http.conflict', 409],
  ['source.versionMismatch', 409],
  ['page.exists', 409],
  ['page.ref.inUse', 409],
  // 429
  ['http.rateLimited', 429],
  ['quota.exceeded', 429],
  // 400 (explicit set)
  ['script.abort', 400],
  ['schema.version.unsupported', 400],
  // 400 (prefix fall-through: data./http./mcp./layout./page.)
  ['data.field.required', 400],
  ['http.param.invalid', 400],
  ['mcp.policy.denied', 400],
  ['layout.tab.labelMissing', 400],
  // 500 (explicit) / 504 / 502
  ['data.schemaDrift', 500],
  ['proxy.timeout', 504],
  ['proxy.unreachable', 502],
  // 500 (unknown code)
  ['script.busy', 500],
];

describe('mapSchemaError', () => {
  it('maps every SchemaError message key to its HTTP status', () => {
    for (const [code, status] of CASES) {
      const spec = mapSchemaError(new SchemaError(code, { object: 'lead' }), 'en');
      expect(spec.status).toBe(status);
      expect(spec.body.error.code).toBe(code);
      expect(typeof spec.body.error.message).toBe('string');
      expect(spec.body.error.message.length).toBeGreaterThan(0);
      expect(spec.body.error.params).toEqual({ object: 'lead' });
    }
  });

  it('re-renders the message in the requested locale', () => {
    const english = mapSchemaError(new SchemaError('auth.missingKey'), 'en').body.error.message;
    const chinese = mapSchemaError(new SchemaError('auth.missingKey'), 'zh').body.error.message;
    expect(english.length).toBeGreaterThan(0);
    expect(chinese).not.toBe(english);
  });

  it('passes through a 4xx statusCode from a non-SchemaError', () => {
    const spec = mapSchemaError(Object.assign(new Error('too large'), { statusCode: 413 }), 'en');
    expect(spec.status).toBe(413);
    expect(spec.body.error.code).toBe('http.param.invalid');
  });

  it('maps any other thrown value to 500 http.internal (no internals leaked)', () => {
    const spec = mapSchemaError(new Error('boom with secret detail'), 'en');
    expect(spec.status).toBe(500);
    expect(spec.body.error.code).toBe('http.internal');
    expect(spec.body.error.message).not.toContain('secret detail');
  });
});

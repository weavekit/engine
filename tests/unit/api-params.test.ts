import { describe, it, expect } from '../helpers/test.js';import { mapSchemaError, parseFindParams } from '../../src/core/api/index.js';
import { LOCALES, SchemaError } from '../../src/core/index.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err instanceof SchemaError ? err.code : (err as Error).message;
  }
}

describe('parseFindParams — syntax parsing (pure function, no fastify)', () => {
  it('empty query → empty ListQuery', () => {
    expect(parseFindParams({})).toEqual({});
  });

  it('filter as JSON object (with nested operators)', () => {
    expect(parseFindParams({ filter: '{"status":"open","age":{"gt":18}}' })).toEqual({
      filter: { status: 'open', age: { gt: 18 } },
    });
  });

  it('filter invalid JSON → http.param.invalid', () => {
    expect(codeOf(() => parseFindParams({ filter: '{bad' }))).toBe('http.param.invalid');
  });

  it('filter as JSON array → http.param.invalid', () => {
    expect(codeOf(() => parseFindParams({ filter: '[]' }))).toBe('http.param.invalid');
  });

  it('filter as JSON scalar → http.param.invalid', () => {
    expect(codeOf(() => parseFindParams({ filter: '"x"' }))).toBe('http.param.invalid');
  });

  it('sort: field:direction comma-separated; default direction=asc', () => {
    expect(parseFindParams({ sort: 'name:asc,created_at:desc' })).toEqual({
      sort: [
        { field: 'name', direction: 'asc' },
        { field: 'created_at', direction: 'desc' },
      ],
    });
    expect(parseFindParams({ sort: 'name' })).toEqual({ sort: [{ field: 'name', direction: 'asc' }] });
  });

  it('sort missing field or missing direction → http.param.invalid', () => {
    expect(codeOf(() => parseFindParams({ sort: 'name:' }))).toBe('http.param.invalid');
    expect(codeOf(() => parseFindParams({ sort: ':asc' }))).toBe('http.param.invalid');
  });

  it('fields: comma-separated, whitespace trimmed', () => {
    expect(parseFindParams({ fields: 'id,name , secret' })).toEqual({ fields: ['id', 'name', 'secret'] });
  });

  it('limit/offset integer parsing', () => {
    expect(parseFindParams({ limit: '10', offset: '5' })).toEqual({ limit: 10, offset: 5 });
  });

  it('limit non-integer/non-numeric → http.param.invalid', () => {
    expect(codeOf(() => parseFindParams({ limit: '10.5' }))).toBe('http.param.invalid');
    expect(codeOf(() => parseFindParams({ limit: 'abc' }))).toBe('http.param.invalid');
  });

  it('repeated parameter (array) → http.param.invalid', () => {
    expect(codeOf(() => parseFindParams({ filter: ['a', 'b'] }))).toBe('http.param.invalid');
  });
});

describe('mapSchemaError — error → HTTP status mapping', () => {
  it('data.recordNotFound → 404 + preserved code/params', () => {
    const spec = mapSchemaError(new SchemaError('data.recordNotFound', { object: 'lead', id: 'L1' }));
    expect(spec.status).toBe(404);
    expect(spec.body.error.code).toBe('data.recordNotFound');
    expect(spec.body.error.params).toEqual({ object: 'lead', id: 'L1' });
  });

  it('data.objectUnknown → 404', () => {
    expect(mapSchemaError(new SchemaError('data.objectUnknown', { object: 'x' })).status).toBe(404);
  });

  it('rbac.denied.* / rbac.teamId.missing → 403', () => {
    expect(mapSchemaError(new SchemaError('rbac.denied.read', { object: 'x', role: 'r' })).status).toBe(403);
    expect(mapSchemaError(new SchemaError('rbac.denied.field', { object: 'x', role: 'r', field: 'f' })).status).toBe(403);
    expect(mapSchemaError(new SchemaError('rbac.teamId.missing', { object: 'x' })).status).toBe(403);
  });

  it('auth.missingKey / auth.invalidKey → 401', () => {
    expect(mapSchemaError(new SchemaError('auth.missingKey', {})).status).toBe(401);
    expect(mapSchemaError(new SchemaError('auth.invalidKey', {})).status).toBe(401);
  });

  it('data.* validation errors → 400', () => {
    expect(mapSchemaError(new SchemaError('data.field.required', { object: 'x', field: 'name' })).status).toBe(400);
    expect(mapSchemaError(new SchemaError('data.field.enum', { object: 'x', field: 's', options: 'a/b' })).status).toBe(400);
  });

  it('http.param.invalid → 400', () => {
    expect(mapSchemaError(new SchemaError('http.param.invalid', { param: 'filter' })).status).toBe(400);
  });

  it('unknown error → 500 + http.internal, no internal info leaked', () => {
    const spec = mapSchemaError(new Error('boom'));
    expect(spec.status).toBe(500);
    expect(spec.body.error.code).toBe('http.internal');
    expect(spec.body.error.message).not.toContain('boom');
  });

  it('fastify 4xx framework error → preserved 4xx + unified body', () => {
    const err = Object.assign(new Error('parse failed'), { statusCode: 400 });
    const spec = mapSchemaError(err);
    expect(spec.status).toBe(400);
    expect(spec.body.error.code).toBe('http.param.invalid');
  });

  it('message re-rendered per locale (constructed in zh → output in en)', () => {
    const err = new SchemaError('http.param.invalid', { param: 'limit' }, LOCALES.ZH);
    const spec = mapSchemaError(err, LOCALES.EN);
    expect(spec.body.error.message).toContain('invalid value for');
  });
});

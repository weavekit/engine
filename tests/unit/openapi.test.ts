import type { ObjectDefinition } from '../../src/core/index.js';
import { buildOpenApiDocument, type OpenApiCapabilities } from '../../src/adapters/openapi/index.js';
import { describe, it, expect } from '../helpers/test.js';

const FULL: OpenApiCapabilities = {
  prefix: '/api',
  events: { prefix: '/api' },
  ingress: { prefix: '/api' },
  audit: true,
  approvals: true,
  proxy: true,
  guardrails: true,
  projectDir: true,
  mcp: { endpoint: '/mcp' },
};

const lead = {
  name: 'lead',
  label: 'Lead',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'title', type: 'string', required: true, minLength: 1 },
    { name: 'status', type: 'enum', options: ['open', 'won'], default: 'open' },
    { name: 'amount', type: 'currency', min: 0 },
    { name: 'supplier_id', type: 'relation', target: 'supplier' },
    { name: 'secret', type: 'string', sensitive: true },
    { name: 'created_at', type: 'datetime', system: true },
  ],
} as unknown as ObjectDefinition;

function methodsAt(doc: ReturnType<typeof buildOpenApiDocument>, path: string): string[] {
  const item = doc.paths[path];
  return item === undefined ? [] : Object.keys(item).sort();
}

describe('buildOpenApiDocument', () => {
  it('documents the full surface in generic mode', () => {
    const doc = buildOpenApiDocument({ objects: [], capabilities: FULL, generic: true });

    expect(doc.openapi).toBe('3.1.0');
    expect(methodsAt(doc, '/api/objects/{name}')).toEqual(['delete', 'get', 'patch', 'post']);
    expect(methodsAt(doc, '/api/objects/{name}/{id}')).toEqual(['delete', 'get', 'patch']);
    expect(methodsAt(doc, '/api/audit')).toEqual(['get']);
    expect(methodsAt(doc, '/api/approvals/{key}/approve')).toEqual(['post']);
    expect(methodsAt(doc, '/api/guardrails/policies/{name}')).toEqual(['get', 'put']);
    expect(methodsAt(doc, '/api/ingress/{source}')).toEqual(['post']);
    expect(methodsAt(doc, '/health')).toEqual(['get']);
    expect(methodsAt(doc, '/mcp')).toEqual(['post']);

    // the shelved pages/UI surface is not advertised
    expect('/api/pages' in doc.paths).toBe(false);
    expect('/api/pages/{path}' in doc.paths).toBe(false);

    // only the live `server` script kind is documented
    const kind = (doc.components.parameters as { kind: { schema: { enum: string[] } } }).kind;
    expect(kind.schema.enum).toEqual(['server']);

    // generic mode: no per-object components
    expect('lead' in doc.components.schemas).toBe(false);
    expect('Error' in doc.components.schemas).toBe(true);
    expect('ObjectRecord' in doc.components.schemas).toBe(true);
  });

  it('gates optional groups by capabilities', () => {
    const doc = buildOpenApiDocument({
      objects: [],
      capabilities: { prefix: '/v1', audit: false, approvals: false, proxy: false, guardrails: false, projectDir: false },
      generic: true,
    });

    expect('/v1/audit' in doc.paths).toBe(false);
    expect('/v1/approvals' in doc.paths).toBe(false);
    expect('/v1/proxy' in doc.paths).toBe(false);
    expect('/v1/objects/{name}/schema' in doc.paths).toBe(false);
    expect('/v1/events' in doc.paths).toBe(false);
    expect('/v1/ingress/{source}' in doc.paths).toBe(false);
    // object CRUD and ops are always present
    expect('/v1/objects/{name}' in doc.paths).toBe(true);
    expect('/health' in doc.paths).toBe(true);
  });

  it('emits per-object schemas with type + RBAC semantics', () => {
    const doc = buildOpenApiDocument({ objects: [lead], capabilities: FULL });

    const record = doc.components.schemas['lead'] as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect('secret' in record.properties).toBe(false);
    expect(record.required).toContain('id');
    expect(record.properties.created_at!.readOnly).toBe(true);
    expect(record.properties.amount!.type).toBe('number');
    expect(record.properties.amount!.minimum).toBe(0);
    expect(record.properties.status!.enum).toEqual(['open', 'won']);
    expect(record.properties.supplier_id).toEqual({ type: 'string' });

    const update = doc.components.schemas['leadUpdate'] as { properties: Record<string, unknown> };
    expect('id' in update.properties).toBe(false);
    expect('created_at' in update.properties).toBe(false);
    expect('title' in update.properties).toBe(true);

    const create = doc.components.schemas['leadCreate'] as { required: string[]; properties: Record<string, unknown> };
    expect(create.required).toContain('title');
    expect('secret' in create.properties).toBe(true); // writable, just not readable
  });

  it('uses unique operationIds', () => {
    const doc = buildOpenApiDocument({ objects: [lead], capabilities: FULL });
    const ids: string[] = [];
    for (const item of Object.values(doc.paths)) {
      for (const operation of Object.values(item)) ids.push((operation as { operationId: string }).operationId);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

import { describe, it, expect } from '../helpers/test.js';
import { buildExpectedTable, createDataAccess, defineObject, diffTable, ObjectRegistry, SchemaError } from '../../src/index.js';
import type { ActualTable } from '../../src/index.js';
import type { DataAccessContext } from '../../src/runtime/data-access/index.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

const ORDER = {
  name: 'order',
  fields: [
    { name: 'id', type: 'string', primary: true },
    { name: 'email', type: 'string' },
    { name: 'tenant_id', type: 'string' },
  ],
  constraints: [{ type: 'unique', fields: ['email', 'tenant_id'] }],
};

function registryOf(defs: Record<string, unknown>[]): ObjectRegistry {
  const reg = new ObjectRegistry();
  for (const d of defs) reg.register(d);
  return reg;
}

function defsOf(reg: ObjectRegistry): Map<string, ReturnType<ObjectRegistry['register']>> {
  return new Map(reg.list().map((d) => [d.name, d]));
}

describe('object-level constraints — validation', () => {
  it('accepts a unique constraint on existing fields', () => {
    const def = defineObject(ORDER);
    expect(def.constraints).toEqual([{ type: 'unique', fields: ['email', 'tenant_id'] }]);
  });

  it('rejects a non-array constraints value', () => {
    expect(codeOf(() => defineObject({ ...ORDER, constraints: {} }))).toBe('object.constraints.notArray');
  });

  it('rejects an unsupported constraint type', () => {
    expect(codeOf(() => defineObject({ ...ORDER, constraints: [{ type: 'check', fields: ['email'] }] }))).toBe(
      'object.constraints.type.invalid',
    );
  });

  it('rejects an empty fields list', () => {
    expect(codeOf(() => defineObject({ ...ORDER, constraints: [{ type: 'unique', fields: [] }] }))).toBe(
      'object.constraints.fields.required',
    );
  });

  it('rejects an unknown field', () => {
    expect(codeOf(() => defineObject({ ...ORDER, constraints: [{ type: 'unique', fields: ['email', 'ghost'] }] }))).toBe(
      'object.constraints.fields.unknown',
    );
  });

  it('rejects a duplicated field', () => {
    expect(codeOf(() => defineObject({ ...ORDER, constraints: [{ type: 'unique', fields: ['email', 'email'] }] }))).toBe(
      'object.constraints.fields.duplicate',
    );
  });

  it('rejects a duplicated constraint (same field set)', () => {
    expect(
      codeOf(() =>
        defineObject({
          ...ORDER,
          constraints: [
            { type: 'unique', fields: ['email', 'tenant_id'] },
            { type: 'unique', fields: ['tenant_id', 'email'] },
          ],
        }),
      ),
    ).toBe('object.constraints.duplicate');
  });

  it('rejects a constraint on a details field (no column)', () => {
    const withDetails = {
      name: 'order',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'lines', type: 'details', target: 'line' },
      ],
      constraints: [{ type: 'unique', fields: ['lines'] }],
    };
    expect(codeOf(() => defineObject(withDetails))).toBe('object.constraints.fields.details');
  });
});

describe('object-level constraints — DDL', () => {
  const reg = registryOf([ORDER]);
  const table = buildExpectedTable(reg.get('order')!, defsOf(reg));

  it('buildExpectedTable derives a composite UNIQUE constraint', () => {
    expect(table.uniques).toEqual([{ name: 'order_email_tenant_id_key', columns: ['email', 'tenant_id'] }]);
  });

  it('CREATE TABLE emits the composite UNIQUE constraint', () => {
    const [create] = diffTable(table, undefined);
    expect(create).toContain('CONSTRAINT "order_email_tenant_id_key" UNIQUE ("email", "tenant_id")');
  });

  it('existing table without the constraint → ADD CONSTRAINT', () => {
    const actual: ActualTable = {
      name: 'order',
      columns: [
        { name: 'id', dataType: 'character varying', isNullable: false, columnDefault: null },
        { name: 'email', dataType: 'character varying', isNullable: true, columnDefault: null },
        { name: 'tenant_id', dataType: 'character varying', isNullable: true, columnDefault: null },
      ],
      pk: ['id'],
      fks: [],
      indexNames: ['order_pkey'],
    };
    const stmts = diffTable(table, actual);
    expect(stmts.join('\n')).toContain('ADD CONSTRAINT "order_email_tenant_id_key" UNIQUE ("email", "tenant_id")');
  });
});

describe('data-access — PG 23505 → data.unique', () => {
  const LEAD = defineObject({
    name: 'lead',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'email', type: 'string' },
      { name: 'tenant_id', type: 'string' },
    ],
    constraints: [{ type: 'unique', fields: ['email', 'tenant_id'] }],
  });

  it('maps a unique violation to a friendly, localized error', async () => {
    const registry = new ObjectRegistry();
    registry.register(LEAD);
    const client = {
      query: async (sql: string) => {
        if (/INSERT INTO/i.test(sql)) {
          const err = new Error('duplicate key value violates unique constraint') as Error & {
            code?: string;
            detail?: string;
          };
          err.code = '23505';
          err.detail = 'Key (email, tenant_id)=(a@x, t1) already exists.';
          throw err;
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client, query: async () => ({ rows: [], rowCount: 0 }) };
    const ctx = { pool, registry, locale: 'en' } as unknown as DataAccessContext;

    let caught: SchemaError | undefined;
    try {
      await createDataAccess().create('lead', { id: '1', email: 'a@x', tenant_id: 't1' }, ctx);
    } catch (error) {
      caught = error instanceof SchemaError ? error : undefined;
    }
    expect(caught?.code).toBe('data.unique');
    expect(caught?.params.fields).toBe('email, tenant_id');
  });
});

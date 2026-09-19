import { describe, it, expect } from '../helpers/test.js';import type { SeqNoField } from '../../src/index.js';
import {
  defineObject,
  renderSeq,
  seqBucket,
  generateSeqNo,
  validateRecord,
  computeFormulas,
  type Queryable,
  type WriteMode,
} from '../../src/index.js';
import { WRITE_MODES } from '../../src/index.js';

const fakeDb = (handler?: (sql: string, params: unknown[]) => unknown) =>
  ({ query: async (sql: string, params: unknown[]) => handler?.(sql, params) ?? { rows: [] } }) as unknown as Queryable;

describe('seqno — format rendering and bucket', () => {
  const now = new Date('2026-05-06T00:00:00Z');
  it('renderSeq zero-padding and date', () => {
    expect(renderSeq('PO-{year}-{seq:6}', 5, now)).toBe('PO-2026-000005');
    expect(renderSeq('{seq}', 12, now)).toBe('12');
    expect(renderSeq('D-{year}{month}{day}-{seq:2}', 3, now)).toBe('D-202656-03');
  });

  it('seqBucket: cycle none prefix, year adds year', () => {
    const f1 = defineObject({ name: 'o', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'no', type: 'seq_no', format: 'PO-{seq:6}' }] });
    const seq1 = f1!.fields[1]! as SeqNoField;
    expect(seqBucket(seq1, 'PO-{seq:6}', now)).toBe('PO-');

    const f2 = defineObject({ name: 'o', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'no', type: 'seq_no', format: 'PO-{year}-{seq:6}', cycle: 'year' }] });
    const seq2 = f2!.fields[1]! as SeqNoField;
    expect(seqBucket(seq2, 'PO-{year}-{seq:6}', now)).toBe('PO-2026-');
  });

  it('generateSeqNo increments and renders', async () => {
    const calls: unknown[][] = [];
    const db = fakeDb((sql) => {
      void sql;
      calls.push([]);
      return { rows: [{ last_value: calls.length }] };
    });
    const f = defineObject({ name: 'o', fields: [{ name: 'id', type: 'string', primary: true }, { name: 'no', type: 'seq_no', format: 'S-{seq:3}' }] })!.fields[1]! as SeqNoField;
    const v1 = await generateSeqNo(db, 'o', f, now);
    const v2 = await generateSeqNo(db, 'o', f, now);
    expect(v1).toBe('S-001');
    expect(v2).toBe('S-002');
  });
});

describe('validateRecord — write validation', () => {
  const order = defineObject({
    name: 'order',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'amount', type: 'currency', min: 0, required: true },
      { name: 'status', type: 'enum', options: ['open', 'closed'], default: 'open' },
      { name: 'code', type: 'string', regex: '^[A-Z]{3}$' },
      { name: 'created_at', type: 'datetime', system: true },
    ],
  });
  const base = { pool: fakeDb(), registry: { get: () => undefined, list: () => [] } as never };
  const v = (data: Record<string, unknown>, mode: WriteMode = WRITE_MODES.CREATE) =>
    validateRecord(order, data, mode, { pool: base.pool, registry: base.registry });

  it('valid create passes', async () => {
    await expect(v({ id: '1', amount: 10, status: 'open', code: 'ABC' })).resolves.toBeUndefined();
  });

  it('missing required rejected', async () => {
    await expect(v({ id: '1', code: 'ABC' })).rejects.toThrow(/required/);
  });

  it('missing primary key rejected', async () => {
    await expect(v({ amount: 10, code: 'ABC' })).rejects.toThrow(/required/);
  });

  it('enum out-of-range rejected', async () => {
    await expect(v({ id: '1', amount: 10, status: 'boom' })).rejects.toThrow(/must be one of/);
  });

  it('min rejected', async () => {
    await expect(v({ id: '1', amount: -1 })).rejects.toThrow(/must be >=/);
  });

  it('regex rejected', async () => {
    await expect(v({ id: '1', amount: 10, code: 'abc' })).rejects.toThrow(/pattern/);
  });

  it('unknown field rejected', async () => {
    await expect(v({ id: '1', amount: 10, ghost: 1 })).rejects.toThrow(/unknown field/);
  });

  it('system field read-only rejected', async () => {
    await expect(v({ id: '1', amount: 10, created_at: '2026-01-01T00:00:00Z' })).rejects.toThrow(/read-only/);
  });
});

describe('computeFormulas — same-object formulas (no DB)', () => {
  const order = defineObject({
    name: 'order',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'unit_price', type: 'number' },
      { name: 'qty', type: 'integer' },
      { name: 'total', type: 'number', formula: 'unit_price * qty' },
      { name: 'label', type: 'string', formula: "'O-' & qty" },
    ],
  });
  it('arithmetic and string formulas', async () => {
    const record: Record<string, unknown> = { id: '1', unit_price: 2, qty: 3 };
    await computeFormulas(order, record, fakeDb(), { get: () => undefined } as never, new Date());
    expect(record.total).toBe(6);
    expect(record.label).toBe('O-3');
  });
});

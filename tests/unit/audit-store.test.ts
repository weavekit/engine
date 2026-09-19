import { describe, it, expect } from '../helpers/test.js';import type { Pool } from 'pg';
import { AUDIT_ACTOR_TYPES, DATA_ACTIONS } from '../../src/subsystems/audit/index.js';
import type { AuditEvent } from '../../src/subsystems/audit/index.js';
import { insertAudit, insertAuditBatch, queryAudit } from '../../src/subsystems/audit/store.js';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function mockPool(): { pool: Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.trimStart().startsWith('SELECT count')) return { rows: [{ n: 42 }] };
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, calls };
}

const EVENT: AuditEvent = {
  actorType: AUDIT_ACTOR_TYPES.USER,
  actorId: 'u1',
  action: DATA_ACTIONS.UPDATE,
  objectName: 'lead',
  objectId: 'L1',
  changes: { status: 'won' },
  isError: true,
  errorCode: 'rbac.denied.field',
  meta: { agentKey: 'sk-a' },
  timestamp: new Date('2026-08-06T00:00:00Z'),
};

describe('insertAudit / insertAuditBatch — SQL parameter mapping', () => {
  it('single: fields→columns, changes/meta JSON-serialized, null handling, timestamp persisted', async () => {
    const { pool, calls } = mockPool();
    await insertAudit(pool, EVENT);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('INSERT INTO weavekit_audit');
    expect(calls[0]!.sql).toContain('before, after');
    expect(calls[0]!.params).toEqual([
      'user', 'u1', DATA_ACTIONS.UPDATE, 'lead', 'L1',
      JSON.stringify({ status: 'won' }), null, null, true, 'rbac.denied.field',
      JSON.stringify({ agentKey: 'sk-a' }),
      EVENT.timestamp,
    ]);
  });

  it('replay event: before/after JSON-serialized on write', async () => {
    const { pool, calls } = mockPool();
    await insertAudit(pool, {
      ...EVENT,
      before: { id: 'L1', status: 'open' },
      after: { id: 'L1', status: 'won' },
    });
    expect(calls[0]!.params).toContain(JSON.stringify({ id: 'L1', status: 'open' }));
    expect(calls[0]!.params).toContain(JSON.stringify({ id: 'L1', status: 'won' }));
  });

  it('optional fields default → null placeholder; timestamp always written', async () => {
    const { pool, calls } = mockPool();
    await insertAudit(pool, { actorType: AUDIT_ACTOR_TYPES.SYSTEM, actorId: 'sys', action: DATA_ACTIONS.DELETE, timestamp: new Date('2026-01-01T00:00:00Z') });
    expect(calls[0]!.params).toEqual([
      'system', 'sys', 'delete', null, null, null, null, null, false, null, null,
      new Date('2026-01-01T00:00:00Z'),
    ]);
  });

  it('batch: single statement with multiple VALUES rows, params expanded', async () => {
    const { pool, calls } = mockPool();
    await insertAuditBatch(pool, [EVENT, EVENT]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12), ($13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)');
    expect(calls[0]!.params).toHaveLength(24);
  });

  it('batch with empty array → no query issued', async () => {
    const { pool, calls } = mockPool();
    await insertAuditBatch(pool, []);
    expect(calls).toHaveLength(0);
  });
});

describe('queryAudit — dynamic WHERE + pagination', () => {
  it('no filter → no WHERE; LIMIT/OFFSET default 100/0', async () => {
    const { pool, calls } = mockPool();
    await queryAudit(pool);
    expect(calls[0]!.sql).toContain('SELECT count(*)::int AS n FROM weavekit_audit');
    expect(calls[0]!.sql).not.toContain('WHERE');
    expect(calls[1]!.sql).toContain('LIMIT $1 OFFSET $2');
    expect(calls[1]!.params).toEqual([100, 0]);
  });

  it('multiple filters combined → parameterized AND clause + pagination param offset', async () => {
    const { pool, calls } = mockPool();
    await queryAudit(pool, { actorId: 'u1', action: DATA_ACTIONS.UPDATE, object: 'lead', from: new Date('2026-01-01'), to: new Date('2026-12-31'), limit: 20, offset: 5 });
    expect(calls[0]!.sql).toContain('actor_id = $1 AND action = $2 AND object = $3 AND ts >= $4 AND ts <= $5');
    expect(calls[1]!.sql).toContain('LIMIT $6 OFFSET $7');
    expect(calls[1]!.params).toEqual(['u1', DATA_ACTIONS.UPDATE, 'lead', new Date('2026-01-01'), new Date('2026-12-31'), 20, 5]);
  });

  it('generic filter: multiple operators on same field + unknown columns ignored', async () => {
    const { pool, calls } = mockPool();
    await queryAudit(pool, { filter: { ts: { gte: '2026-08-01', lte: '2026-08-31' }, action: { like: 'create' }, ghost: 'x' }, limit: 10, offset: 0 });
    expect(calls[1]!.sql).toContain('("ts" >= $1 AND "ts" <= $2) AND "action" ILIKE $3');
    expect(calls[1]!.params).toEqual(['2026-08-01', '2026-08-31', '%create%', 10, 0]);
  });

  it('generic filter: $or groups OR (ANDed with top-level conditions)', async () => {
    const { pool, calls } = mockPool();
    await queryAudit(pool, {
      filter: { $or: [{ is_error: true }, { action: { eq: 'delete' } }] },
      limit: 10,
      offset: 0,
    });
    expect(calls[1]!.sql).toContain('(("is_error" = $1) OR ("action" = $2))');
    expect(calls[1]!.params).toEqual([true, 'delete', 10, 0]);
  });
});

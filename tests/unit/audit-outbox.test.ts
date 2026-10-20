import { describe, it, expect } from '../helpers/test.js';
import type { Pool, PoolClient } from 'pg';
import {
  AUDIT_ACTOR_TYPES,
  createOutboxAuditSink,
  createTransactionalAuditSink,
  startAuditOutboxRelay,
} from '../../src/subsystems/audit/index.js';
import type { AuditEngine } from '../../src/subsystems/audit/index.js';
import type { AuditEvent } from '../../src/core/audit/index.js';

const EVENT: AuditEvent = {
  actorType: AUDIT_ACTOR_TYPES.USER,
  actorId: 'u1',
  action: 'update',
  objectName: 'lead',
  objectId: 'L1',
  changes: { status: 'won' },
  timestamp: new Date('2026-08-06T00:00:00Z'),
};

interface Call {
  sql: string;
  params: unknown[];
}

function recorder(): { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
}

describe('audit outbox / transactional sinks', () => {
  it('durable sink: recordInTx writes an outbox row on the caller client; record writes via the pool', async () => {
    const pool = recorder();
    const sink = createOutboxAuditSink(pool as unknown as Pool);
    await sink.recordInTx!(EVENT, recorder() as unknown as PoolClient);
    await sink.record(EVENT);
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]!.sql).toContain('INSERT INTO weavekit_audit_outbox');
    expect(pool.calls[0]!.params).toEqual([JSON.stringify(EVENT)]);
    expect(sink.recordInTx).toBeDefined();
  });

  it('durable sink: recordInTx targets the passed client (not the pool)', async () => {
    const pool = recorder();
    const client = recorder();
    const sink = createOutboxAuditSink(pool as unknown as Pool);
    await sink.recordInTx!(EVENT, client as unknown as PoolClient);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.sql).toContain('weavekit_audit_outbox');
    expect(pool.calls).toHaveLength(0);
  });

  it('transactional sink: recordInTx inserts into weavekit_audit; record delegates to the engine', async () => {
    const recorded: AuditEvent[] = [];
    const audit = {
      record: async (e: AuditEvent) => { recorded.push(e); },
      recordBatch: async () => {},
      query: async () => ({ rows: [], total: 0 }),
      close: async () => {},
    } as unknown as AuditEngine;
    const sink = createTransactionalAuditSink(audit);
    const client = recorder();
    await sink.recordInTx!(EVENT, client as unknown as PoolClient);
    expect(client.calls[0]!.sql).toContain('INSERT INTO weavekit_audit');
    expect(client.calls[0]!.params[0]).toBe('user');
    await sink.record(EVENT);
    expect(recorded).toHaveLength(1);
  });

  it('relay calls onPersisted inside the transaction with the inserted audit id', async () => {
    const calls: Call[] = [];
    let selected = false;
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.startsWith('SELECT id, event')) {
          if (selected) return { rows: [] };
          selected = true;
          return { rows: [{ id: '1', event: EVENT }] };
        }
        if (sql.includes('INSERT INTO weavekit_audit')) return { rows: [{ id: '42' }] };
        return { rows: [] };
      },
      release: () => {},
    };
    const pool = {
      connect: async () => client,
    } as unknown as Pool;
    const persisted: { id: string; event: AuditEvent }[] = [];
    const relay = startAuditOutboxRelay({
      pool,
      onPersisted: async (event, id) => {
        persisted.push({ id, event });
      },
    });
    await relay.drain();
    await relay.close();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.id).toBe('42');
    expect(persisted[0]!.event).toBe(EVENT);
    expect(calls.some((c) => c.sql === 'COMMIT')).toBe(true);
    expect(calls.some((c) => c.sql.startsWith('DELETE FROM weavekit_audit_outbox'))).toBe(true);
  });

  it('relay rolls back and keeps the outbox row when onPersisted throws', async () => {
    const calls: Call[] = [];
    let selected = false;
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.startsWith('SELECT id, event')) {
          if (selected) return { rows: [] };
          selected = true;
          return { rows: [{ id: '1', event: EVENT }] };
        }
        if (sql.includes('INSERT INTO weavekit_audit')) return { rows: [{ id: '42' }] };
        return { rows: [] };
      },
      release: () => {},
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const relay = startAuditOutboxRelay({
      pool,
      onPersisted: async () => {
        throw new Error('delivery enqueue failed');
      },
    });
    await expect(relay.drain()).rejects.toThrow(/delivery enqueue failed/);
    await relay.close();
    expect(calls.some((c) => c.sql === 'ROLLBACK')).toBe(true);
    expect(calls.some((c) => c.sql.startsWith('DELETE FROM weavekit_audit_outbox'))).toBe(false);
  });
});

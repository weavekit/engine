import type { Pool, PoolClient } from 'pg';
import { SYSTEM_TABLES } from '../../core/index.js';
import type { AuditEvent, AuditSink } from '../../core/audit/index.js';
import { insertAuditBatch } from './store.js';

/** insert an outbox row inside the caller's transaction (durable-mode producer) */
export async function writeOutboxInTx(client: PoolClient, event: AuditEvent): Promise<void> {
  await client.query(
    `INSERT INTO ${SYSTEM_TABLES.AUDIT_OUTBOX} (event) VALUES ($1::jsonb)`,
    [JSON.stringify(event)],
  );
}

/**
 * Durable-mode sink: transactional writes go to `weavekit_audit_outbox` (same
 * transaction as the business write); non-transactional writes (RBAC denials,
 * tool calls) enqueue through the pool. A relay then delivers to
 * `weavekit_audit` + the live channel.
 */
export function createOutboxAuditSink(pool: Pool): AuditSink {
  return {
    async record(event) {
      await pool.query(
        `INSERT INTO ${SYSTEM_TABLES.AUDIT_OUTBOX} (event) VALUES ($1::jsonb)`,
        [JSON.stringify(event)],
      );
    },
    async recordInTx(event, client) {
      await writeOutboxInTx(client, event);
    },
  };
}

export interface AuditOutboxRelayOptions {
  pool: Pool;
  /** called after each event is durably written (SSE dual-emit) */
  publish?: (event: AuditEvent) => void;
  pollMs?: number;
  batchSize?: number;
  onError?: (error: Error) => void;
}

export interface AuditOutboxRelay {
  /** drain pending rows now (idempotent) */
  drain(): Promise<void>;
  /** stop polling and drain once (used by engine.close) */
  close(): Promise<void>;
}

/**
 * Background relay draining `weavekit_audit_outbox` into `weavekit_audit` and
 * the live channel. Multi-instance safe (`FOR UPDATE SKIP LOCKED`), and
 * at-least-once: rows are deleted only after a successful insert + commit, so a
 * crash between insert and delete redelivers.
 */
export function startAuditOutboxRelay(options: AuditOutboxRelayOptions): AuditOutboxRelay {
  const pollMs = options.pollMs ?? 1000;
  const batchSize = options.batchSize ?? 100;
  const onError = options.onError ?? ((error: Error) => console.error('audit outbox relay failed:', error.message));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let closed = false;

  async function drainOnce(): Promise<void> {
    for (;;) {
      const client = await options.pool.connect();
      let events: AuditEvent[] = [];
      try {
        await client.query('BEGIN');
        const res = await client.query(
          `SELECT id, event FROM ${SYSTEM_TABLES.AUDIT_OUTBOX} ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1`,
          [batchSize],
        );
        const rows = res.rows as { id: string; event: AuditEvent }[];
        if (rows.length === 0) {
          await client.query('COMMIT');
          break;
        }
        events = rows.map((r) => r.event);
        await insertAuditBatch(client, events);
        await client.query(`DELETE FROM ${SYSTEM_TABLES.AUDIT_OUTBOX} WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      if (options.publish !== undefined) for (const event of events) options.publish(event);
      if (events.length < batchSize) break;
    }
  }

  function schedule(): void {
    if (closed || timer !== undefined || running) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, pollMs);
    timer.unref?.();
  }

  async function run(): Promise<void> {
    if (running || closed) return;
    running = true;
    try {
      await drainOnce();
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      running = false;
      schedule();
    }
  }

  schedule();

  return {
    async drain() {
      await drainOnce();
    },
    async close() {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      try {
        await drainOnce();
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

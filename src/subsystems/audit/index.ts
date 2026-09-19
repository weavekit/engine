import type { Pool } from 'pg';
import type { AuditEvent, AuditSink } from '../../core/audit/index.js';
import { ensureAuditTable, insertAudit, insertAuditBatch, queryAudit } from './store.js';
import type { AuditQuery, AuditQueryResult } from './store.js';

export { AUDIT_ACTOR_TYPES, DATA_ACTIONS, NOOP_AUDIT_SINK } from '../../core/audit/index.js';
export type { AuditActorType, AuditEvent, AuditFilter, AuditSink, DataAction } from '../../core/audit/index.js';
export type { AuditQuery, AuditQueryResult } from './store.js';

/** audit engine: storage (single/batch insert) + query + lifecycle */
export interface AuditEngine extends AuditSink {
  record(event: AuditEvent): Promise<void>;
  recordBatch(events: AuditEvent[]): Promise<void>;
  query(filter?: AuditQuery): Promise<AuditQueryResult>;
  /** flush any buffered events (no-op for the raw store) and release resources */
  close(): Promise<void>;
}

/** create the PG-backed audit engine (idempotent table creation) */
export async function createAudit(pool: Pool): Promise<AuditEngine> {
  await ensureAuditTable(pool);
  return {
    async record(event) {
      await insertAudit(pool, event);
    },
    async recordBatch(events) {
      await insertAuditBatch(pool, events);
    },
    async query(filter) {
      return queryAudit(pool, filter);
    },
    async close() {
      // raw store has no buffer
    },
  };
}

export interface BufferedSinkOptions {
  /** events per batch; defaults to 50 */
  batchSize?: number;
  /** max time between flushes; defaults to 100ms */
  flushMs?: number;
  /** batch-write failure callback (default console.error) — never throws into the caller */
  onError?: (error: Error) => void;
}

/** hard cap on retained events when the sink is unreachable — above this the oldest are dropped + reported (prevents OOM) */
const MAX_BUFFERED_EVENTS = 10_000;

/**
 * L1 process-local buffered audit sink (fire-and-forget): `record()` queues
 * and returns immediately — audit never blocks the business critical path.
 * Events are flushed as a single multi-row INSERT when the batch fills or the
 * flush window elapses. `flush()` drains the queue (used by engine.close()).
 *
 * Upgrade path: replace `inner` with a Redis producer / S3 writer later —
 * callers of `record()` are unchanged.
 */
export function createBufferedAuditSink(
  inner: AuditSink,
  options: BufferedSinkOptions = {},
): AuditSink & { flush(): Promise<void> } {
  const batchSize = options.batchSize ?? 50;
  const flushMs = options.flushMs ?? 100;
  const onError = options.onError ?? ((error: Error) => console.error('audit flush failed:', error.message));

  let buffer: AuditEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> | undefined;
  let closed = false;

  async function flushNow(): Promise<void> {
    const events = buffer;
    buffer = [];
    if (events.length === 0) return;
    try {
      if (inner.recordBatch !== undefined) {
        await inner.recordBatch(events);
      } else {
        for (const event of events) await inner.record(event);
      }
    } catch (error) {
      // requeue the batch and let the next flush window retry — audit is
      // best-effort but must not be lossy on a transient DB/network failure.
      // If the sink stays down the buffer grows; a hard cap prevents OOM and
      // reports through onError instead of silently dropping events.
      buffer.unshift(...events);
      if (buffer.length > MAX_BUFFERED_EVENTS) {
        const dropped = buffer.splice(MAX_BUFFERED_EVENTS);
        onError(
          new Error(
            `audit buffer overflow: dropped ${dropped.length} events (sink unreachable — last: ${
              error instanceof Error ? error.message : String(error)
            })`,
          ),
        );
      } else {
        onError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /** serialized flush: wait for an in-flight flush, then drain the queue */
  async function runFlush(): Promise<void> {
    if (flushing !== undefined) {
      await flushing;
    } else {
      flushing = flushNow().finally(() => {
        flushing = undefined;
      });
      await flushing;
    }
    if (buffer.length > 0) schedule();
  }

  function schedule(): void {
    if (closed || timer !== undefined || flushing !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runFlush();
    }, flushMs);
    // a retry timer must never keep the process alive (audit is best-effort):
    // if the sink stays down and the app is shutting down, the buffered events
    // are dropped on process exit and reported through onError at the last flush
    timer.unref?.();
  }

  function enqueue(events: AuditEvent[]): void {
    if (closed) return;
    buffer.push(...events);
    if (buffer.length >= batchSize) {
      void runFlush();
    } else {
      schedule();
    }
  }

  return {
    async record(event) {
      enqueue([event]);
    },
    async recordBatch(events) {
      enqueue(events);
    },
    async flush() {
      // stop accepting/rescheduling after the final drain — a late flush must
      // never run against a pool that engine.close() has already ended
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await runFlush();
    },
  };
}

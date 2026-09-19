import { describe, it, expect } from '../helpers/test.js';import { AUDIT_ACTOR_TYPES, DATA_ACTIONS, createBufferedAuditSink } from '../../src/subsystems/audit/index.js';
import type { AuditEvent, AuditSink } from '../../src/subsystems/audit/index.js';

const EVENTS: AuditEvent[] = [1, 2, 3].map((n) => ({
  actorType: AUDIT_ACTOR_TYPES.USER,
  actorId: `u${n}`,
  action: DATA_ACTIONS.CREATE,
  timestamp: new Date(),
}));

function collectingSink(): { sink: AuditSink; single: AuditEvent[]; batches: AuditEvent[][] } {
  const single: AuditEvent[] = [];
  const batches: AuditEvent[][] = [];
  return {
    sink: {
      async record(event) {
        single.push(event);
      },
      async recordBatch(events) {
        batches.push(events);
      },
    },
    single,
    batches,
  };
}

describe('createBufferedAuditSink — L1 in-process batched async queue', () => {
  it('record() returns immediately without persisting (fire-and-forget)', async () => {
    const inner = collectingSink();
    const buffered = createBufferedAuditSink(inner.sink, { batchSize: 10, flushMs: 5000 });
    await buffered.record(EVENTS[0]!);
    expect(inner.batches).toHaveLength(0);
    expect(inner.single).toHaveLength(0);
  });

  it('batchSize reached → batch persist (multiple rows)', async () => {
    const inner = collectingSink();
    const buffered = createBufferedAuditSink(inner.sink, { batchSize: 2, flushMs: 5000 });
    await buffered.record(EVENTS[0]!);
    await buffered.record(EVENTS[1]!);
    expect(inner.batches).toHaveLength(1);
    expect(inner.batches[0]).toHaveLength(2);
  });

  it('flushMs timeout → timed batch persist', async () => {
    const inner = collectingSink();
    const buffered = createBufferedAuditSink(inner.sink, { batchSize: 50, flushMs: 20 });
    await buffered.record(EVENTS[0]!);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(inner.batches).toHaveLength(1);
    expect(inner.batches[0]).toHaveLength(1);
  });

  it('flush() drains remaining events (used by engine.close)', async () => {
    const inner = collectingSink();
    const buffered = createBufferedAuditSink(inner.sink, { batchSize: 50, flushMs: 5000 });
    await buffered.record(EVENTS[0]!);
    await buffered.record(EVENTS[1]!);
    await buffered.flush();
    expect(inner.batches).toHaveLength(1);
    expect(inner.batches[0]).toHaveLength(2);
    expect(inner.single).toHaveLength(0);
  });

  it('inner without recordBatch → falls back to per-record record', async () => {
    const single: AuditEvent[] = [];
    const sink: AuditSink = {
      async record(event) {
        single.push(event);
      },
    };
    const buffered = createBufferedAuditSink(sink, { batchSize: 1, flushMs: 5000 });
    await buffered.record(EVENTS[0]!);
    expect(single).toHaveLength(1);
  });

  it('batch write failure → not thrown to caller + onError callback', async () => {
    let errored: Error | undefined;
    const failSink: AuditSink = {
      async recordBatch() {
        throw new Error('db down');
      },
      async record() {
        throw new Error('db down');
      },
    };
    const buffered = createBufferedAuditSink(failSink, {
      batchSize: 2,
      flushMs: 5000,
      onError: (e) => {
        errored = e;
      },
    });
    await buffered.record(EVENTS[0]!); // no throw
    await buffered.record(EVENTS[1]!); // triggers batch; failure goes through onError
    await buffered.flush();
    expect(errored?.message).toBe('db down');
  });

  it('flush failure → events requeued, persisted on retry after sink recovers (H3 no loss)', async () => {
    let fail = true;
    const batches: AuditEvent[][] = [];
    const sink: AuditSink = {
      async record() {},
      async recordBatch(events) {
        if (fail) throw new Error('db down');
        batches.push(events);
      },
    };
    const buffered = createBufferedAuditSink(sink, { batchSize: 50, flushMs: 5000 });
    await buffered.record(EVENTS[0]!);
    await buffered.record(EVENTS[1]!);
    await buffered.flush(); // first flush → fails, events requeued (no loss)
    expect(batches).toHaveLength(0);
    fail = false;
    await buffered.flush(); // retry → persisted successfully
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it('flush() stops accepting new events (close semantics, prevents late flush after pool.end)', async () => {
    const inner = collectingSink();
    const buffered = createBufferedAuditSink(inner.sink, { batchSize: 50, flushMs: 5000 });
    await buffered.record(EVENTS[0]!);
    await buffered.flush();
    expect(inner.batches).toHaveLength(1);
    // events recorded after close must not reach the inner sink (no late flush
    // against an already-ended pool)
    await buffered.record(EVENTS[1]!);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(inner.batches).toHaveLength(1);
    expect(inner.single).toHaveLength(0);
  });
});

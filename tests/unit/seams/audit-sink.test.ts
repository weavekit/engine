import { describe, it, expect } from '../../helpers/test.js';
import type { AuditEvent } from '../../../src/core/audit/index.js';
import {
  NOOP_AUDIT_SINK,
  createBufferedAuditSink,
  createTransactionalAuditSink,
  type AuditEngine,
} from '../../../src/subsystems/audit/index.js';

/**
 * `AuditSink` seam contract — what an alternative (enterprise) sink can rely on:
 * the capability methods a mode requires, and the guarantee that audit failures
 * never propagate into the business path.
 */

const event = (action = 'test'): AuditEvent => ({
  actorType: 'system',
  actorId: 'system',
  action,
  timestamp: new Date(),
});

describe('AuditSink seam contract', () => {
  it('NOOP sink accepts record + recordBatch', async () => {
    await NOOP_AUDIT_SINK.record(event());
    await NOOP_AUDIT_SINK.recordBatch?.([event(), event()]);
  });

  it('transactional sink is tx-capable (exposes recordInTx)', () => {
    const audit: AuditEngine = {
      record: async () => {},
      recordBatch: async () => {},
      query: async () => ({ rows: [], total: 0 }),
      close: async () => {},
    };
    const sink = createTransactionalAuditSink(audit);
    expect(typeof sink.recordInTx).toBe('function');
  });

  it('buffered sink isolates a failing inner: record() never throws into the caller', async () => {
    const errors: Error[] = [];
    const sink = createBufferedAuditSink(
      {
        record: async () => {
          throw new Error('audit backend down');
        },
      },
      { flushMs: 5, onError: (e) => errors.push(e) },
    );
    await sink.record(event()); // must resolve, not reject
    await sink.flush();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toContain('down');
  });

  it('buffered sink merges a batch into recordBatch when the inner supports it', async () => {
    const batches: number[] = [];
    const sink = createBufferedAuditSink(
      {
        record: async () => {},
        recordBatch: async (events) => {
          batches.push(events.length);
        },
      },
      { batchSize: 1 },
    );
    await sink.record(event('a'));
    await sink.flush();
    expect(batches.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1);
  });
});

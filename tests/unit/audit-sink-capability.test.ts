import { describe, it, expect } from '../helpers/test.js';
import { assertAuditSinkCapability } from '../../src/subsystems/audit/index.js';
import type { AuditSink } from '../../src/core/audit/index.js';

const plainSink: AuditSink = { record: async () => {} };
const txSink: AuditSink = { record: async () => {}, recordInTx: async () => {} };

/**
 * Audit durability seam guard: `transactional`/`durable` require an
 * in-transaction sink (`recordInTx`). A custom sink without it must fail
 * closed at wiring time rather than silently degrade to best-effort.
 */
describe('audit sink capability guard', () => {
  it('best-effort accepts any sink', () => {
    expect(() => assertAuditSinkCapability('best-effort', plainSink)).not.toThrow();
  });

  it('transactional/durable accept a tx-capable sink', () => {
    expect(() => assertAuditSinkCapability('transactional', txSink)).not.toThrow();
    expect(() => assertAuditSinkCapability('durable', txSink)).not.toThrow();
  });

  it('fails closed when a durable mode lacks recordInTx', () => {
    expect(() => assertAuditSinkCapability('transactional', plainSink)).toThrow(/recordInTx/);
    expect(() => assertAuditSinkCapability('durable', plainSink)).toThrow(/recordInTx/);
  });

  it('allows best-effort fallback only when explicitly opted in', () => {
    expect(() => assertAuditSinkCapability('durable', plainSink, { allowBestEffortFallback: true })).not.toThrow();
  });
});

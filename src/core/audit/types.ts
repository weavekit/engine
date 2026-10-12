/**
 * Audit contract — vocabulary + data types re-exported from
 * `@weave-kit/contract`; the pluggable sink/engine seams stay here (they take a
 * `pg` client, so they can't live in the zero-dependency contract).
 */

import type { PoolClient } from 'pg';
import type { AuditEvent, AuditQuery, AuditQueryResult } from '@weave-kit/contract';

export { AUDIT_ACTOR_TYPES, AUDIT_MODES, DATA_ACTIONS, ACTION_PREFIXES } from '@weave-kit/contract/values';
export type { AuditActorType, AuditMode, DataAction, ActionPrefix } from '@weave-kit/contract/values';
export type { AuditEvent, AuditFilter, AuditQuery, AuditQueryResult } from '@weave-kit/contract';

/**
 * audit write contract — replaceable implementation (PG / object store / log
 * service / async queue). Stable seam (`@enterprise-reserved`): a closed-source
 * enterprise layer may provide an alternative sink (export/retention/compliance
 * are enterprise E2); the engine ships the PG default.
 */
export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
  /** optional batch write (multi-row INSERT); buffered sink uses it to merge DB round-trips */
  recordBatch?(events: AuditEvent[]): Promise<void>;
  /**
   * Write an audit event **inside the caller's open transaction** (transactional
   * / durable modes). Optional on `AuditSink`, but a sink used with those modes
   * **must** implement it: without it the writer falls back to best-effort
   * `record` and events can be lost on crash. Wiring code enforces this via
   * `assertAuditSinkCapability` (fail-closed). An implementation throwing here
   * rolls the business write back.
   */
  recordInTx?(event: AuditEvent, client: PoolClient): Promise<void>;
}

/** no-op sink: audit disabled → zero imports, zero tables, zero queries */
export const NOOP_AUDIT_SINK: AuditSink = {
  record: async () => {},
  recordBatch: async () => {},
};

/**
 * Audit query capability — protocol adapters depend on this core contract only
 * (the PG store in `subsystems/audit` satisfies it structurally), keeping the
 * adapters→subsystems import ban intact.
 */
export interface AuditQueryEngine extends AuditSink {
  query(filter?: AuditQuery): Promise<AuditQueryResult>;
}

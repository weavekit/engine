import type { AuditEvent } from '../../audit/index.js';

/**
 * Engine live event contract — pure interfaces, zero dependencies.
 * Implementations live in `infrastructure/event`; the SSE adapter in
 * `adapters/events`; data-access only depends on the narrow publisher that the
 * assembly layer injects (keeps "disabled = not imported = zero overhead").
 */

/** event types — single source of truth (as const, see AGENTS.md) */
export const EVENT_TYPES = {
  RECORD_CREATED: 'record.created',
  RECORD_UPDATED: 'record.updated',
  RECORD_DELETED: 'record.deleted',
  AUDIT_EVENT: 'audit.event',
  SCHEMA_CHANGED: 'schema.changed',
  SCHEMA_DRIFT: 'schema.drift',
  LIFECYCLE_SHUTDOWN: 'lifecycle.shutdown',
} as const;
export type EventType = typeof EVENT_TYPES[keyof typeof EVENT_TYPES];

/** lifecycle markers broadcast to every subscriber (e.g. instance shut down) */
export const LIFECYCLE_KINDS = {
  SHUTDOWN: 'shutdown',
} as const;
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[keyof typeof LIFECYCLE_KINDS];

/** which write produced a record event */
export type RecordAction = 'created' | 'updated' | 'deleted';

/** record change payload — minimal on purpose (object + id, never sensitive columns) */
export interface RecordChangePayload {
  object: string;
  id: string;
}

/** audit payload — the full AuditEvent, filtered per-subscriber before delivery */
export interface AuditEventPayload {
  event: AuditEvent;
}

/** schema reload / metadata invalidation notification — no payload */
export interface SchemaChangedPayload {
  kind: 'schema';
}

/**
 * schema/DB drift surfaced to connected frontends: a `weave dev` reload was
 * rejected because an existing table (object without `alter: true`) lacks a
 * declared field's column. The old engine keeps serving; subscribers get the
 * precise reason + how to fix.
 */
export interface SchemaDriftPayload {
  /** object whose schema drifted from its table */
  object: string;
  /** the declared field with no live column (when known) */
  field?: string;
  /** human-readable reason (i18n'd by the sender) */
  message: string;
}

/** lifecycle marker payload (e.g. `{ kind: 'shutdown' }` on instance exit) */
export interface LifecyclePayload {
  kind: LifecycleKind;
}

/** type-specific payload */
export type EventPayload = RecordChangePayload | AuditEventPayload | SchemaChangedPayload | SchemaDriftPayload | LifecyclePayload;

/** one engine event with a monotonically increasing sequence (replay anchor) */
export interface EngineEvent {
  seq: number;
  ts: Date;
  type: EventType;
  payload: EventPayload;
}

/** input for publishing (seq/ts are assigned by the bus) */
export interface PublishInput {
  type: EventType;
  payload: EventPayload;
}

/** replay outcome: `ok` replay delivered; `gap` the requested window is unrecoverable (restart/overflow) */
export type ReplayResult = 'ok' | 'gap';

/**
 * Narrow publisher injected into data-access / audit so they never touch the
 * bus — the write path only knows how to emit domain events.
 */
export interface EventPublisher {
  publishRecordChange(action: RecordAction, object: string, id: string): void;
  publishAudit(event: AuditEvent): void;
  publishSchemaChanged(): void;
  /** notify connected subscribers that a schema reload was rejected (drift) */
  publishSchemaDrift(payload: SchemaDriftPayload): void;
  /** broadcast a lifecycle marker to every subscriber (e.g. instance shutdown) */
  publishLifecycle(kind: LifecycleKind): void;
}

/** full in-process pub/sub with a bounded replay buffer (implemented by infrastructure) */
export interface EventBus {
  publish(input: PublishInput): void;
  subscribe(listener: (event: EngineEvent) => void): () => void;
  /** deliver buffered events with `seq > afterSeq`; `gap` when the window is unrecoverable */
  replay(afterSeq: number, listener: (event: EngineEvent) => void): ReplayResult;
  /** latest emitted sequence (0 when nothing published) */
  lastSeq(): number;
  close(): void;
}

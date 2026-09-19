/**
 * Audit contract — pure interfaces, zero dependencies. The storage
 * implementation lives in `subsystems/audit`; data-access and adapter
 * layers depend on this contract only (keeps "disabled = not imported" and
 * the adapters→subsystems dependency ban intact).
 */

/** who initiated the event — single source of truth (as const, see AGENTS.md) */
export const AUDIT_ACTOR_TYPES = {
  AGENT: 'agent',
  USER: 'user',
  SYSTEM: 'system',
  ANONYMOUS: 'anonymous',
} as const;
export type AuditActorType = typeof AUDIT_ACTOR_TYPES[keyof typeof AUDIT_ACTOR_TYPES];

/**
 * Engine data-access actions — closed set (as const single source of truth).
 * Writes (create/update/delete) plus read: read denials are audited too.
 */
export const DATA_ACTIONS = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  READ: 'read',
} as const;
export type DataAction = typeof DATA_ACTIONS[keyof typeof DATA_ACTIONS];

/**
 * Interface-layer action namespace prefixes (open names; prefix is the
 * contract). Consumers compose full actions as `<prefix>.<detail>`, e.g.
 * `mcp.tool.search_lead`.
 */
export const ACTION_PREFIXES = {
  MCP_TOOL: 'mcp.tool',
  REST: 'rest',
  SCHEMA: 'schema',
} as const;
export type ActionPrefix = typeof ACTION_PREFIXES[keyof typeof ACTION_PREFIXES];

/** immutable audit event */
export interface AuditEvent {
  actorType: AuditActorType;
  /** subject.id / agentKey / 'system' */
  actorId: string;
  /** 'create' | 'update' | 'delete' | 'mcp.tool.search' | ... */
  action: string;
  /** object name */
  objectName?: string;
  /** record id */
  objectId?: string;
  /** write payload / change summary; tool-call argument summary for operations */
  changes?: unknown;
  /** row snapshot before the write (M10 replay; `subsystems.audit.replay: true` only) */
  before?: unknown;
  /** row snapshot after the write (update only; M10 replay) */
  after?: unknown;
  isError?: boolean;
  /** engine SchemaError code, e.g. 'rbac.denied.update' */
  errorCode?: string;
  /** extension: agentKey/onBehalfOf/tool/latency etc. */
  meta?: Record<string, unknown>;
  timestamp: Date;
}

/** audit write contract — replaceable implementation (PG / object store / log service / async queue) */
export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
  /** optional batch write (multi-row INSERT); buffered sink uses it to merge DB round-trips */
  recordBatch?(events: AuditEvent[]): Promise<void>;
}

/** no-op sink: audit disabled → zero imports, zero tables, zero queries */
export const NOOP_AUDIT_SINK: AuditSink = {
  record: async () => {},
  recordBatch: async () => {},
};

/**
 * Generic audit filter — structural, mirrors the object `Filter`: plain field
 * conditions AND'd with an optional `$or` group. Field names are raw
 * `weavekit_audit` columns (`ts`, `actor_id`, `action`, `object`,
 * `object_id`, `is_error`, `error_code`, `actor_type`) and operator values
 * follow the single-source `FILTER_OPS` (gt/gte/lt/lte/eq/ne/in/like).
 * Kept standalone + protocol-neutral so `core/audit` stays independent of the
 * object data-access layer; the store validates columns against its whitelist.
 */
export type AuditFilter = {
  [column: string]: unknown;
  $or?: Array<{ [column: string]: unknown }>;
};

/** audit query filter (protocol-neutral — REST/ops/adapter layer maps wire params onto it) */
export interface AuditQuery {
  actorId?: string;
  action?: string;
  object?: string;
  from?: Date;
  to?: Date;
  /** generic `weavekit_audit` column filter; OR'd/AND'd with the typed fields above */
  filter?: AuditFilter;
  limit?: number;
  offset?: number;
}

/** paginated audit query result (rows newest-first: ORDER BY ts DESC, id DESC) */
export interface AuditQueryResult {
  rows: AuditEvent[];
  total: number;
}

/**
 * Audit query capability — protocol adapters depend on this core contract only
 * (the PG store in `subsystems/audit` satisfies it structurally), keeping the
 * adapters→subsystems import ban intact.
 */
export interface AuditQueryEngine extends AuditSink {
  query(filter?: AuditQuery): Promise<AuditQueryResult>;
}

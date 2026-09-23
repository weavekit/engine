import type { RbacSubject } from '../rbac/index.js';
import type { Locale } from '../i18n/index.js';
import type { AuditSink } from '../audit/index.js';
import type { ApprovalStatus } from './values.js';

/**
 * Tool-surface contracts (open contract). Zero-dependency, no runtime
 * imports — `runtime` depends on `core`, so `core` must not reference runtime
 * types (dependency DAG). The runtime `ObjectDataAccess` structurally
 * satisfies `ToolDataAccess` (method bivariance), so no adapter is needed at
 * the boundary beyond the executor passing the injected instance through.
 */

/** minimal JSON Schema subset used for tool input/output (plain objects, no zod) */
export interface ToolJsonSchema {
  type?: string;
  properties?: Record<string, ToolJsonSchema>;
  required?: string[];
  items?: ToolJsonSchema;
  enum?: string[];
  description?: string;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
}

/** controlled data-access surface exposed to tools — no raw pool/SQL/network */
export interface ToolFindOptions {
  filter?: Record<string, unknown>;
  sort?: Array<{ field: string; dir?: string }>;
  limit?: number;
  offset?: number;
  fields?: string[];
}
export interface ToolFindResult<T = Record<string, unknown>> {
  rows: T[];
  total: number;
}
export interface ToolDataAccessContext {
  subject?: RbacSubject;
  locale?: Locale;
}
export interface ToolDataAccess {
  find<T = Record<string, unknown>>(objectName: string, opts: ToolFindOptions, ctx: ToolDataAccessContext): Promise<ToolFindResult<T>>;
  findOne<T = Record<string, unknown>>(objectName: string, id: string, ctx: ToolDataAccessContext): Promise<T | null>;
  create<T = Record<string, unknown>>(objectName: string, data: Record<string, unknown>, ctx: ToolDataAccessContext): Promise<T>;
  update<T = Record<string, unknown>>(objectName: string, id: string, changes: Record<string, unknown>, ctx: ToolDataAccessContext): Promise<T>;
  delete(objectName: string, id: string, ctx: ToolDataAccessContext): Promise<void>;
}

/**
 * Protocol-agnostic caller identity. `subject` (RBAC decisions) is the proxied
 * user; `actor` is the caller (agent). Mapped from `McpSession` at the adapter
 * boundary — the executor never imports adapter types.
 */
export interface ToolActor {
  /** caller API key (audit actorId / rate-limit key source) */
  key: string;
  /** caller identity label (audit meta) */
  label: string;
  /** proxied-user reference (audit meta) */
  onBehalfOf: string;
}

/** guardrail handle exposed to tools (executor wires the real limiter) */
export interface ToolGuardrails {
  checkRateLimit(key: string, scope?: string): boolean;
}

export interface PendingApproval {
  approvalKey: string;
  action: string;
  args: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: Date;
  /** requester's actor key (deterministic-approval-key input) */
  actorKey: string;
  /** actor (approver key) that resolved the entry */
  approvedBy?: string;
}

/**
 * Approval queue filter (persisted-store query model). `from`/`to` bound the
 * `createdAt` window; `sort` defaults to `createdAt` DESC.
 */
export interface ApprovalListFilter {
  status?: ApprovalStatus;
  action?: string;
  actorKey?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
  sort?: { field: 'createdAt' | 'action' | string; order: 'ASC' | 'DESC' };
}

/**
 * Pluggable approval store (persistence backend). Implementations: in-memory
 * (`core/tools`, tests/default) and PG (`subsystems/approvals`, MIT — the
 * engine's mandated DB). A Redis backend is not implemented. The store
 * never audits — resolution audit belongs to the queue facade.
 */
export interface ApprovalsBackend {
  list(filter?: ApprovalListFilter): Promise<PendingApproval[]>;
  get(approvalKey: string): Promise<PendingApproval | undefined>;
  upsert(entry: PendingApproval): Promise<void>;
  /** resolve a pending entry to `approved`/`rejected`; false when absent or not pending */
  resolve(approvalKey: string, by: string, status: 'approved' | 'rejected'): Promise<boolean>;
  count(filter?: ApprovalListFilter): Promise<number>;
}

/**
 * Approval queue handle (async — a persisted backend performs I/O). Single-level
 * gate; multi-level flows belong to workflow. Custom tool handlers receive this
 * as `ctx.approvals` and must `await`.
 */
export interface ToolApprovals {
  /** list with the full filter model (status/action/actorKey/time + paging/sort) */
  list(filter?: ApprovalListFilter): Promise<PendingApproval[]>;
  count(filter?: ApprovalListFilter): Promise<number>;
  /** convenience: all entries of one status (equivalent to `list({ status })`) */
  query(status?: ApprovalStatus): Promise<PendingApproval[]>;
  approve(approvalKey: string, by: string): Promise<boolean>;
  reject(approvalKey: string, by: string): Promise<boolean>;
}

/** tool execution result envelope (protocol-agnostic; adapter maps to MCP content) */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** everything a custom tool handler may use — no raw pool/SQL/network */
export interface ToolCallContext {
  dataAccess: ToolDataAccess;
  subject: RbacSubject;
  actor: ToolActor;
  /** caller-supplied arguments of this invocation */
  args: Record<string, unknown>;
  /** audit action of this invocation (e.g. `mcp.tool.<name>`); protocol binding decides the prefix */
  action: string;
  audit: AuditSink;
  guardrails: ToolGuardrails;
  approvals: ToolApprovals;
  /** cross-object atomic execution (new `DataAccessContext.client` primitive) */
  withTx<T>(fn: (ctx: ToolCallContext) => Promise<T>): Promise<T>;
}

/** user-defined tool loaded from `toolsDir` (default export of a tool module) */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolJsonSchema;
  /** allow-list: roles not listed simply never see the tool (not validated — the engine has no role registry) */
  roles?: string[];
  handler(ctx: ToolCallContext): Promise<ToolResult>;
}

/** policy decision — `allow`/`deny`/`requireApproval`/`mask`, fail-closed on policy errors */
export type GuardrailDecision =
  | { allow: true; mask?: Record<string, string> }
  | { allow: false; reason: string; errorCode?: string }
  | { allow: false; requireApproval: true; approvalKey: string };

/** guardrail policy decision context (protocol-agnostic; `action` = tool name or workflow transition) */
export interface GuardrailContext {
  actor: ToolActor;
  subject: RbacSubject;
  action: string;
  args: Record<string, unknown>;
  /** amount-threshold style policies read business data through the same narrow surface */
  dataAccess: ToolDataAccess;
}

export interface GuardrailPolicy {
  name: string;
  decide(ctx: GuardrailContext): GuardrailDecision | Promise<GuardrailDecision>;
}

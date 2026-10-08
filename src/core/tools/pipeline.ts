/**
 * Agent-execution pipeline contracts (protocol-agnostic, zero-dependency).
 *
 * One execution (a tool call, a REST/MCP write, a workflow transition) is a
 * sequence of stages — Plan → Validate → Authorize → Guardrail → Approval →
 * Execute → Commit → Evidence. Adapters bind protocol specifics; the runtime
 * orchestrates; every stage outcome is captured as an {@link Evidence} record.
 */

/** ordered execution stages — single source of truth (as const, AGENTS hard rule) */
export const EXECUTION_STAGES = {
  PLAN: 'plan',
  VALIDATE: 'validate',
  AUTHORIZE: 'authorize',
  GUARDRAIL: 'guardrail',
  APPROVAL: 'approval',
  EXECUTE: 'execute',
  COMMIT: 'commit',
  EVIDENCE: 'evidence',
} as const;
export type ExecutionStage = typeof EXECUTION_STAGES[keyof typeof EXECUTION_STAGES];

/** outcome of a single stage */
export const EXECUTION_OUTCOMES = {
  OK: 'ok',
  DENY: 'deny',
  PENDING: 'pending',
  ERROR: 'error',
} as const;
export type ExecutionOutcome = typeof EXECUTION_OUTCOMES[keyof typeof EXECUTION_OUTCOMES];

/** what the caller intends to do (protocol-neutral; `action` e.g. `object.lead.create`) */
export interface ExecutionPlan {
  action: string;
  objectName?: string;
  objectId?: string;
  args: Record<string, unknown>;
  /** optional human/agent-supplied intent summary */
  intent?: string;
}

/** one recorded stage outcome */
export interface ExecutionStageRecord {
  stage: ExecutionStage;
  outcome: ExecutionOutcome;
  detail?: string;
  at: Date;
}

/**
 * A complete, correlatable record of one execution. `requestId`/`traceId`/
 * `schemaRevision` link it to the request, the schema revision and the audit
 * stream. The engine only captures/records evidence; export/retention belong to
 * the enterprise E2 layer.
 */
export interface Evidence {
  requestId?: string;
  traceId?: string;
  schemaRevision?: string;
  actor: { key: string; label: string; onBehalfOf?: string };
  subjectId?: string;
  plan: ExecutionPlan;
  stages: ExecutionStageRecord[];
  approvalKey?: string;
  isError: boolean;
  errorCode?: string;
  timestamp: Date;
}

/** evidence sink — optional; absent = zero overhead */
export interface EvidenceSink {
  record(evidence: Evidence): Promise<void>;
}

/** no-op sink: evidence disabled → zero imports, zero tables, zero queries */
export const NOOP_EVIDENCE_SINK: EvidenceSink = {
  record: async () => {},
};

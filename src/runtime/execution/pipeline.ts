import {
  EXECUTION_OUTCOMES,
  EXECUTION_STAGES,
  SchemaError,
  type Evidence,
  type EvidenceSink,
  type ExecutionOutcome,
  type ExecutionPlan,
  type ExecutionStageRecord,
  type IdentitySubject,
  type Locale,
  type ToolActor,
} from '../../core/index.js';

/**
 * Protocol-agnostic execution orchestrator (W2.2). Runs one execution through
 * the Plan → Validate → Authorize → Guardrail → Approval → Execute → Commit →
 * Evidence stages, records every stage outcome, and emits one {@link Evidence}.
 *
 * The gate (`gate`) reuses the existing guardrail + approval lifecycle
 * (`runtime/tools/policies.ts` `evaluateCall`); `execute` owns its own
 * transaction (data-access / tool). Deny/pending short-circuit `execute`.
 */

/** per-call context carried through the pipeline (also embedded in Evidence) */
export interface PipelineContext {
  actor: ToolActor;
  subject: IdentitySubject;
  requestId?: string;
  traceId?: string;
  schemaRevision?: string;
  locale?: Locale;
}

/** allow / deny / pending decision from the guardrail+approval gate */
export type PipelineGate =
  | { kind: 'allow'; mask?: Record<string, string> }
  | { kind: 'deny'; reason: string; errorCode: string }
  | { kind: 'pending'; approvalKey: string };

export interface PipelineDeps {
  /** pre-execution validation; throws on invalid input (`tool.args.invalid`) */
  validate?: (plan: ExecutionPlan, ctx: PipelineContext) => Promise<void>;
  /** RBAC-style authorization (optional; data-access also enforces); throws to deny */
  authorize?: (plan: ExecutionPlan, ctx: PipelineContext) => Promise<void>;
  /** guardrail + approval gate; absent = allow */
  gate?: (plan: ExecutionPlan, ctx: PipelineContext) => Promise<PipelineGate>;
  /** the actual work; owns its transaction/commit */
  execute: (plan: ExecutionPlan, ctx: PipelineContext) => Promise<unknown>;
  /** evidence sink (absent = zero overhead) */
  evidence?: EvidenceSink;
}

export interface PipelineResult {
  outcome: ExecutionOutcome;
  result?: unknown;
  reason?: string;
  errorCode?: string;
  approvalKey?: string;
  mask?: Record<string, string>;
  error?: unknown;
  evidence: Evidence;
}

function policyErrorCode(error: unknown): string | undefined {
  return error instanceof SchemaError ? error.code : undefined;
}

/**
 * Run one execution through the pipeline. `execute` errors are captured
 * (outcome `error`, original error in `result.error`) and **not rethrown**, so
 * the caller maps every outcome uniformly to its protocol envelope.
 */
export async function runPipeline(
  plan: ExecutionPlan,
  ctx: PipelineContext,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const stages: ExecutionStageRecord[] = [];
  const push = (stage: ExecutionStageRecord['stage'], outcome: ExecutionOutcome, detail?: string): void => {
    stages.push(detail === undefined ? { stage, outcome, at: new Date() } : { stage, outcome, detail, at: new Date() });
  };

  const buildEvidence = (
    outcome: ExecutionOutcome,
    extra: { approvalKey?: string; errorCode?: string } = {},
  ): Evidence => ({
    ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
    ...(ctx.traceId === undefined ? {} : { traceId: ctx.traceId }),
    ...(ctx.schemaRevision === undefined ? {} : { schemaRevision: ctx.schemaRevision }),
    actor: ctx.actor,
    subjectId: ctx.subject.id,
    plan,
    stages,
    ...(extra.approvalKey === undefined ? {} : { approvalKey: extra.approvalKey }),
    isError: outcome !== EXECUTION_OUTCOMES.OK,
    ...(extra.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
    timestamp: new Date(),
  });

  const finish = async (result: PipelineResult): Promise<PipelineResult> => {
    push(EXECUTION_STAGES.EVIDENCE, result.outcome);
    result.evidence.stages = stages;
    if (deps.evidence !== undefined) {
      try {
        await deps.evidence.record(result.evidence);
      } catch {
        // evidence is best-effort: never break the execution
      }
    }
    return result;
  };

  push(EXECUTION_STAGES.PLAN, EXECUTION_OUTCOMES.OK);

  if (deps.validate !== undefined) {
    try {
      await deps.validate(plan, ctx);
      push(EXECUTION_STAGES.VALIDATE, EXECUTION_OUTCOMES.OK);
    } catch (error) {
      push(EXECUTION_STAGES.VALIDATE, EXECUTION_OUTCOMES.DENY);
      const errorCode = policyErrorCode(error);
      return finish({
        outcome: EXECUTION_OUTCOMES.DENY,
        reason: error instanceof Error ? error.message : String(error),
        ...(errorCode === undefined ? {} : { errorCode }),
        error,
        evidence: buildEvidence(EXECUTION_OUTCOMES.DENY, errorCode === undefined ? {} : { errorCode }),
      });
    }
  }

  if (deps.authorize !== undefined) {
    try {
      await deps.authorize(plan, ctx);
      push(EXECUTION_STAGES.AUTHORIZE, EXECUTION_OUTCOMES.OK);
    } catch (error) {
      push(EXECUTION_STAGES.AUTHORIZE, EXECUTION_OUTCOMES.DENY);
      const errorCode = policyErrorCode(error);
      return finish({
        outcome: EXECUTION_OUTCOMES.DENY,
        reason: error instanceof Error ? error.message : String(error),
        ...(errorCode === undefined ? {} : { errorCode }),
        error,
        evidence: buildEvidence(EXECUTION_OUTCOMES.DENY, errorCode === undefined ? {} : { errorCode }),
      });
    }
  }

  let mask: Record<string, string> | undefined;
  if (deps.gate !== undefined) {
    let gate: PipelineGate;
    try {
      gate = await deps.gate(plan, ctx);
    } catch (error) {
      // fail-closed: a throwing gate denies
      push(EXECUTION_STAGES.GUARDRAIL, EXECUTION_OUTCOMES.DENY);
      return finish({
        outcome: EXECUTION_OUTCOMES.DENY,
        reason: error instanceof Error ? error.message : String(error),
        errorCode: 'mcp.policy.denied',
        error,
        evidence: buildEvidence(EXECUTION_OUTCOMES.DENY, { errorCode: 'mcp.policy.denied' }),
      });
    }
    if (gate.kind === 'deny') {
      push(EXECUTION_STAGES.GUARDRAIL, EXECUTION_OUTCOMES.DENY, gate.reason);
      return finish({
        outcome: EXECUTION_OUTCOMES.DENY,
        reason: gate.reason,
        errorCode: gate.errorCode,
        evidence: buildEvidence(EXECUTION_OUTCOMES.DENY, { errorCode: gate.errorCode }),
      });
    }
    if (gate.kind === 'pending') {
      push(EXECUTION_STAGES.GUARDRAIL, EXECUTION_OUTCOMES.OK);
      push(EXECUTION_STAGES.APPROVAL, EXECUTION_OUTCOMES.PENDING, gate.approvalKey);
      return finish({
        outcome: EXECUTION_OUTCOMES.PENDING,
        approvalKey: gate.approvalKey,
        errorCode: 'mcp.approval.pending',
        evidence: buildEvidence(EXECUTION_OUTCOMES.PENDING, { approvalKey: gate.approvalKey }),
      });
    }
    mask = gate.mask;
    push(EXECUTION_STAGES.GUARDRAIL, EXECUTION_OUTCOMES.OK);
    push(EXECUTION_STAGES.APPROVAL, EXECUTION_OUTCOMES.OK);
  }

  try {
    const result = await deps.execute(plan, ctx);
    push(EXECUTION_STAGES.EXECUTE, EXECUTION_OUTCOMES.OK);
    push(EXECUTION_STAGES.COMMIT, EXECUTION_OUTCOMES.OK);
    return finish({
      outcome: EXECUTION_OUTCOMES.OK,
      result,
      ...(mask === undefined ? {} : { mask }),
      evidence: buildEvidence(EXECUTION_OUTCOMES.OK),
    });
  } catch (error) {
    push(EXECUTION_STAGES.EXECUTE, EXECUTION_OUTCOMES.ERROR);
    const errorCode = policyErrorCode(error);
    return finish({
      outcome: EXECUTION_OUTCOMES.ERROR,
      error,
      ...(errorCode === undefined ? {} : { errorCode }),
      evidence: buildEvidence(EXECUTION_OUTCOMES.ERROR, errorCode === undefined ? {} : { errorCode }),
    });
  }
}

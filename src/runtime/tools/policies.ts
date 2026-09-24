import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluatePolicies } from '../../core/index.js';
import type { ApprovalStatus, GuardrailContext, GuardrailDecision, GuardrailPolicy, MessageKey, ToolResult } from '../../core/index.js';

/**
 * Guardrail policy pipeline on top of the pure `evaluatePolicies` core:
 * policy loading (array or directory of `.js` modules), the approval gate
 * (deterministic key → pending → host approve → client retry) and result
 * masking (JSON top-level field replacement). Fail-closed and the
 * decision matrix live in the core evaluator.
 */

export type PolicyGateResult =
  | { kind: 'allow'; mask?: Record<string, string> }
  | { kind: 'deny'; reason: string; errorCode: string }
  | { kind: 'pending'; approvalKey: string };

export interface PolicyApprovals {
  query(): Promise<Array<{ approvalKey: string; status: ApprovalStatus; action: string; args: Record<string, unknown> }>>;
  pending(action: string, args: Record<string, unknown>, actor: { key: string }, key?: string): Promise<void>;
}

/** deterministic approval key (repeat calls don't duplicate) — mirror of the executor helper */
export function policyApprovalKey(actorKey: string, action: string, args: Record<string, unknown>): string {
  const raw = JSON.stringify([actorKey, action, args]);
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) {
    hash = (hash << 5) - hash + raw.charCodeAt(i);
    hash |= 0;
  }
  return `ap-${Math.abs(hash).toString(36)}`;
}

/**
 * Run the decision pipeline and resolve the approval lifecycle for one call:
 * already approved → allow (client retry path); rejected → deny; unknown →
 * enqueue pending → report `pending`. The caller (executor) turns deny/pending
 * into isError results + audits.
 */
export async function evaluateCall(
  policies: GuardrailPolicy[],
  approvals: PolicyApprovals,
  ctx: GuardrailContext,
): Promise<PolicyGateResult> {
  if (policies.length === 0) return { kind: 'allow' };

  const decision = await evaluatePolicies(policies, ctx);
  if (decision.allow === false) {
    if ('requireApproval' in decision) {
      return resolveApproval(approvals, decision.approvalKey ?? policyApprovalKey(ctx.actor.key, ctx.action, ctx.args), ctx);
    }
    return { kind: 'deny', reason: decision.reason, errorCode: decision.errorCode ?? 'mcp.policy.denied' };
  }
  return { kind: 'allow', mask: decision.mask };
}

/** resolve a `requireApproval` decision: approved → allow; rejected → deny; absent → enqueue pending */
async function resolveApproval(
  approvals: PolicyApprovals,
  approvalKey: string,
  ctx: GuardrailContext,
): Promise<PolicyGateResult> {
  const key = approvalKey === '' ? policyApprovalKey(ctx.actor.key, ctx.action, ctx.args) : approvalKey;
  const existing = (await approvals.query()).find((a) => a.approvalKey === key);
  if (existing?.status === 'approved') return { kind: 'allow' };
  if (existing?.status === 'rejected') {
    return { kind: 'deny', reason: 'approval was rejected', errorCode: 'mcp.approval.notFound' };
  }
  if (existing === undefined) {
    await approvals.pending(ctx.action, ctx.args, ctx.actor, key);
  }
  return { kind: 'pending', approvalKey: key };
}

/** transition-guard result with typed message keys (the caller throws the SchemaError) */
export type TransitionGateResult =
  | { kind: 'allow' }
  | { kind: 'deny'; code: MessageKey; reason?: string }
  | { kind: 'pending'; approvalKey: string };

/**
 * Guardrail gate for a workflow transition. Runs the shared policy set (a policy
 * self-filters on `ctx.action`) and/or the transition's own `requiresApproval`
 * flag, then resolves the approval lifecycle. No policies and no flag → allow.
 */
export async function evaluateTransition(
  policies: readonly GuardrailPolicy[],
  approvals: PolicyApprovals | undefined,
  ctx: GuardrailContext,
  requireApproval: boolean,
): Promise<TransitionGateResult> {
  let decision: GuardrailDecision = { allow: true };
  if (policies.length > 0) decision = await evaluatePolicies(policies, ctx);
  if (decision.allow === true) {
    if (!requireApproval) return { kind: 'allow' };
    decision = { allow: false, requireApproval: true, approvalKey: policyApprovalKey(ctx.actor.key, ctx.action, ctx.args) };
  }
  if ('requireApproval' in decision) {
    if (approvals === undefined) return { kind: 'deny', code: 'workflow.approval.unavailable' };
    const result = await resolveApproval(approvals, decision.approvalKey, ctx);
    if (result.kind === 'allow') return { kind: 'allow' };
    if (result.kind === 'pending') return { kind: 'pending', approvalKey: result.approvalKey };
    return { kind: 'deny', code: 'mcp.policy.denied', reason: result.reason };
  }
  return { kind: 'deny', code: 'mcp.policy.denied', reason: decision.reason };
}

/** mask a tool result's JSON top-level fields: non-JSON / parse failure passes through */
export function applyMask(result: ToolResult, mask: Record<string, string>): ToolResult {
  const text = result.content.find((b) => b.type === 'text')?.text;
  if (text === undefined) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return result;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return result;
  const out = { ...(parsed as Record<string, unknown>) };
  let changed = false;
  for (const [field, replacement] of Object.entries(mask)) {
    if (field in out) {
      out[field] = replacement;
      changed = true;
    }
  }
  if (!changed) return result;
  return {
    content: [{ type: 'text', text: JSON.stringify(out) }],
    isError: result.isError,
  };
}

const POLICY_FILE_EXTENSIONS = ['.js', '.mjs', '.cjs'];

/** load a policies directory: each module's default export is a policy or a policy array */
export async function loadPoliciesDir(dir: string): Promise<GuardrailPolicy[]> {
  let isDir = false;
  try {
    isDir = (await stat(dir)).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) return [];

  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile() && POLICY_FILE_EXTENSIONS.some((ext) => e.name.endsWith(ext))).map((e) => join(dir, e.name)).sort();
  const policies: GuardrailPolicy[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    const value = mod.default;
    if (Array.isArray(value)) {
      policies.push(...(value as GuardrailPolicy[]));
    } else if (value !== undefined && typeof value === 'object') {
      policies.push(value as GuardrailPolicy);
    }
  }
  return policies;
}

/** resolve `tools.guardrails.policies` (array or directory path) into an array */
export async function resolvePolicies(source: GuardrailPolicy[] | string | undefined, baseDir: string): Promise<GuardrailPolicy[]> {
  if (source === undefined) return [];
  if (Array.isArray(source)) return source;
  return loadPoliciesDir(join(baseDir, source));
}

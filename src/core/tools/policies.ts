import type { GuardrailContext, GuardrailDecision, GuardrailPolicy } from './types.js';

/**
 * Guardrail policy evaluation core — pure, zero-dependency, protocol-agnostic
 * (D13: tool calls today, workflow activities later both run this). Policies
 * run in declaration order; the first `deny`/`requireApproval` short-circuits;
 * `mask` decisions merge (later wins). Fail-closed: a policy that throws denies
 * the call (`mcp.policy.denied`). No policies configured = fast-path allow.
 */
export async function evaluatePolicies(
  policies: readonly GuardrailPolicy[],
  ctx: GuardrailContext,
): Promise<GuardrailDecision> {
  if (policies.length === 0) return { allow: true };

  let mask: Record<string, string> | undefined;
  for (const policy of policies) {
    let decision: GuardrailDecision;
    try {
      decision = await policy.decide(ctx);
    } catch (error) {
      // fail-closed: a failing policy denies the call
      return {
        allow: false,
        reason: `policy "${policy.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
        errorCode: 'mcp.policy.denied',
      };
    }
    if (!decision.allow) return decision;
    if (decision.mask !== undefined) {
      mask = { ...mask, ...decision.mask };
    }
  }
  return mask !== undefined ? { allow: true, mask } : { allow: true };
}

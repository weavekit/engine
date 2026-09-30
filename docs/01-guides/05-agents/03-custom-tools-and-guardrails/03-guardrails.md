---
title: Guardrail policies
description: "A decision pipeline in front of every tool call: allow, deny, requireApproval or mask."
---

# Guardrail policies

Policies run **before every custom-tool call** and decide whether it may proceed. Configure them
inline or as a directory:

```ts
// weavekit.config.ts
import { writeProtection } from './policies';

export default {
  tools: {
    toolsDir: 'tools',
    guardrails: {
      policies: [
        { name: 'no-delete', decide: () => ({ allow: false, reason: 'deletes are prohibited' }) },
        // ... or load a directory:  policies: 'policies'  → each .js default-exports a policy
      ],
    },
  },
};
```

## Decisions

| Decision | Meaning |
| --- | --- |
| `{ allow: true }` | proceed |
| `{ allow: false, reason, errorCode? }` | deny the call (`mcp.policy.denied`) |
| `{ allow: false, requireApproval: true, approvalKey }` | suspend for human approval |
| `{ allow: true, mask: { field: '***' } }` | proceed, but replace the named **top-level fields** of the returned JSON text (non-JSON output passes through) |

A policy receives `{ actor, subject, action, args, dataAccess }` — the same controlled surface, so an
amount-threshold rule can read the current row:

```ts
const highValue = {
  name: 'approve-high-value',
  decide: async (ctx) => {
    const order = await ctx.dataAccess.findOne('order', ctx.args.order_id as string, { subject: ctx.subject });
    if (order !== null && Number(order.total) > 10_000) {
      return { allow: false, requireApproval: true, approvalKey: 'approve-big-order' };
    }
    return { allow: true };
  },
};
```

## Fail-closed, not fail-open

- A policy that **throws** denies the call (`mcp.policy.denied`) — fail-closed.
- A call that **no policy matches** is allowed. Fail-closed applies to errors, not to absence. Without
  policies, the pipeline is a no-op fast path.

## Order of evaluation

`rate limit → policies → execute`.

## Approval flow (single-level gate)

1. A `requireApproval` decision suspends the call: the client gets `isError` with `mcp.approval.pending`
   and the `approvalKey`.
2. A host or manager approves through the queue:
   `await engine.tools.executor.approvals.approve(key, 'manager')`.
3. The **client retries the same call**. The gate sees the approved key and lets it through.

The approval key is deterministic (a hash of actor + action + args), so repeated calls don't duplicate
pending entries. Rejection turns the retry into a deny. The queue is persisted behind a pluggable
`ApprovalsBackend` (PG by default; no Redis backend is implemented), and the approval methods are
`async`. This is a **single-level gate by design**: one call, one decision — guardrails never becomes a
workflow engine.

Policies also gate **workflow transitions** — they self-filter on `workflow.transition.<object>.<action>`.
See [Workflow → Admin & guardrails](../../06-workflow/06-admin.md) and [Approvals](../04-approvals.md).

## Related

- [Custom tools](02-custom-tools.md)
- [Approvals](../04-approvals.md) — the queue behind `requireApproval`
- [Audit replay](04-audit-replay.md)

# Quotas & usage budgets

A **quota** is a durable, fixed-period hard budget — "the DingTalk integration may make 10 000 calls
per month" — enforced across engine instances. It answers a different question from rate limiting:

| | Rate limit (`adapters.*.rateLimit`) | Quota (`config.quotas`) |
| --- | --- | --- |
| Measures | request velocity | spend over a period |
| Storage | in-memory, per process | PostgreSQL (`weavekit_counters`) |
| Direction | inbound throttling | any metered work you decide |
| Scope | one engine instance | all instances (atomic) |

## Enable

```ts
// weavekit.config.ts
export default {
  // …
  quotas: {}, // PostgreSQL-backed; creates weavekit_counters on startup
} satisfies EngineConfig;
```

When `quotas` is absent the store isn't created (zero overhead). With it, `engine.quotas` is a
`CounterStore`.

## Consume against a budget

The engine provides the mechanism; **your application supplies the semantics** — which key, which
limit, which period. Check the budget around the work itself, typically an outbound integration call:

```ts
import { assertQuota, COUNTER_PERIODS } from '@weave-kit/engine';

// inside a tool / service / proxy resolver, before calling the external API:
await assertQuota(
  engine.quotas!,
  `dingtalk:${tenantId}`,           // opaque key — the engine never interprets it
  { limit: 10_000, period: COUNTER_PERIODS.MONTH },
  locale,
);
// …only reached when within budget
```

`assertQuota` throws `quota.exceeded` (HTTP 429) when the budget is spent. Use the non-throwing check
when you want to choose a fallback:

```ts
import { consumeQuota } from '@weave-kit/engine';

const decision = await consumeQuota(engine.quotas!, key, policy);
if (!decision.allowed) {
  // fall back / queue / surface a warning — decision.remaining and decision.resetAt explain when it frees up
}
```

## Guarantees

- **Atomic and cross-instance** — a single `INSERT … ON CONFLICT DO UPDATE … WHERE` statement, so two engine replicas cannot overspend the same budget.
- **Denied consumes don't count** — a rejected call leaves the counter untouched.
- **UTC periods** — `day` runs midnight → midnight; `month` runs the 1st → next 1st.
- **Pluggable backend** — the PG store is the default, and another backend can be injected behind the same `CounterStore` contract (mirroring the approvals backend) without changing call sites or adding an engine dependency.

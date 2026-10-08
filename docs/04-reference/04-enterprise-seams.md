---
title: "Enterprise seams"
description: "The stable extension points the closed-source enterprise layer implements on top of the MIT engine — and where the boundary is."
---

# Enterprise seams

The engine (`@weave-kit/engine`) is a **MIT, headless** runtime. Governance and
compliance capabilities that would otherwise fork `core` are delivered by a
separate **closed-source** layer (`@weave-kit/enterprise`, gated on adoption).
The engine's job is to keep a small set of **stable seams** — interfaces whose
semantics, error behavior and evolution are contract-tested — so that layer can
plug in without depending on engine internals.

> Rule: the engine never imports enterprise, and never branches on
> `edition`/`license`. Enterprise never forks `core`; it implements a seam and
> injects it through config.

## The seams

| Seam | Declaration | Engine default | Enterprise |
| --- | --- | --- | --- |
| `AuditSink` | `core/audit/types.ts` | PG store + best-effort / transactional / durable modes | **E2** export, retention, WORM/compliance |
| `ApprovalsBackend` | `core/tools/types.ts` | in-memory + PG | **E3** Redis / HA coordination |
| `WorkflowTimerStore` / `WorkflowBackend` | `core/types/workflow.ts` | PG `weavekit_workflow_timers` (`FOR UPDATE SKIP LOCKED`) | **E3** Redis / HA timers |
| `IdentityStore` | `core/provider/identity/directory.ts` | PG `weavekit_user` / `weavekit_department` | **E1** SSO / SCIM directory sync |
| `AuthSource` / `Authenticator` | `adapters/auth/source.ts` | static key map or custom resolver | **E1** SSO / OIDC / SAML |
| `AuthVerifier` | `adapters/auth/verify.ts` | — (contract only) | **E1** protocol verifiers |
| `GuardrailPolicy` | `core/tools/types.ts` | in-process policies | **E5** Redis-backed advanced guardrails |
| `ProxyTargetResolver` | `core/proxy/types.ts` | app-supplied resolver | target governance / Cloud control plane |
| `MetricsSink` / `TraceSink` | `core/observability/index.ts` | no-op | telemetry backend / Cloud metering (**E6**) |

Every seam except the observability sinks is marked `@enterprise-reserved` in
source. `tests/unit/seams/` pins the consumer-facing guarantees (error, close,
retry, idempotency) so an enterprise implementation can rely on them.

## Audit durability

`audit.mode` selects durability: `best-effort` (default) is a fire-and-forget
process buffer; `transactional` writes the audit row inside the business
transaction; `durable` writes a transactional outbox row plus a relay
(crash-safe, at-least-once). `transactional`/`durable` require an
in-transaction sink — startup fails closed (`assertAuditSinkCapability`) unless
the host sets `allowBestEffortFallback: true`. **Export, retention and
compliance policy are enterprise E2**; the engine only captures.

## Observability (metrics & trace)

The engine **emits** metrics and finished spans; it ships no dashboard, alerting
or exporter. Inject a sink via `config.observability`:

```ts
export default {
  // ...
  observability: {
    metrics: myOtelMetricsSink,   // implements MetricsSink
    trace: myOtelTraceSink,       // implements TraceSink
  },
};
```

Emitted metrics are the single-source `METRIC_NAMES`: `http.request.duration_ms`,
`http.response`, `rbac.deny`, `audit.success`, `audit.failure`,
`query.budget.reject`, `pool.state`, `execution.duration_ms`.

**Label discipline (contract):** label values must be low-cardinality and
PII-free. Never put tenant data, record ids, SQL text, credentials or other
secrets in labels — those belong in the (audited) data path, not in metrics.
Trace correlation uses the inbound W3C `traceparent` (see `core/trace.ts`).

## Writing a backend

1. Implement the interface from `@weave-kit/engine` (types are re-exported from
   the package root).
2. Inject it through the corresponding config field (or `createEngine` options).
3. Rely on the documented error/close/retry contract — do **not** depend on
   engine internals.

Anything not on this list is engine-internal and may change between minor
releases; see [Contract freeze](03-contract-freeze.md) for the frozen surface.

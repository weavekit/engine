---
title: Observability
description: "Low-level metrics and trace emission — the engine emits, you bring the backend."
---

# Observability

The engine **emits** metrics and finished spans through two narrow, protocol-neutral seams. It ships
no backend, dashboard, alerting or exporter — inject your own (OpenTelemetry, Prometheus, a cloud
APM). The default is a **no-op**, so telemetry costs nothing unless you opt in.

```ts
// weavekit.config.ts
export default {
  // ...
  observability: {
    metrics: myMetricsSink,   // implements MetricsSink
    trace: myTraceSink,       // implements TraceSink
  },
};
```

Both sinks are **synchronous** and must never throw into the request path. They are also exposed at
runtime as `engine.observability.{metrics,trace}` (always present; no-op until you inject one).

## Metrics

`MetricsSink` has `counter(name, value?, labels?)`, `gauge(name, value, labels?)` and
`histogram(name, value, labels?)`. The engine only emits the single-source `METRIC_NAMES`:

| Metric | Kind | Labels |
| --- | --- | --- |
| `http.request.duration_ms` | histogram | `method`, `route`, `status` |
| `http.response` | counter | `method`, `route`, `status` |
| `rbac.deny` | counter | `object`, `action` |
| `query.budget.reject` | counter | `object`, `limit` |
| `audit.success` / `audit.failure` | counter | `mode` |
| `pool.state` | gauge | `state` |
| `execution.duration_ms` | histogram | `kind` |

`audit.success` / `audit.failure` / `pool.state` / `execution.duration_ms` are **defined** (reserved)
and wired where cheap; the others are emitted today. Names are frozen single-source values
(`METRIC_NAMES`), so a rename is a contract change.

## Label discipline (contract)

Label values must be **low-cardinality and PII-free**. Never put tenant data, record ids, SQL text,
credentials or other secrets in labels — those belong in the (audited) data path, not in metrics.
Stick to routing/enum-like values (`method`, `route`, `status`, `object`, `action`).

## Trace

The engine does not manage span lifecycles; it records a **finished span** per HTTP response through
`TraceSink.recordSpan(...)`. Correlation uses the inbound **W3C `traceparent`** header, parsed by
`core/trace.ts` (`parseTraceparent` / `traceIdOf`):

- The parsed `traceId` is threaded into `AuditEvent.traceId`, evidence, and the SSE audit stream, so a
  request can be traced end to end across the API, the audit trail and execution evidence.
- On each REST response the engine emits an `http.request.duration_ms` histogram and, when a
  `traceparent` is present, one span named after the route.
- A missing or malformed `traceparent` is simply **no trace context** — never a request failure.

## Enterprise boundary

Telemetry backends, alerting, dashboards and Cloud metering (**E6**) are the enterprise/product layer.
The engine only defines the seam and emits; it never imports a telemetry SDK.

## Related
- [Audit](03-audit.md) — `traceId` on events and the audit query cursor
- [Execution & evidence](../05-agents/05-execution-and-evidence.md) — `requestId` / `traceId` / `schemaRevision` correlation
- [Enterprise seams](../../04-reference/04-enterprise-seams.md) — the full seam catalog

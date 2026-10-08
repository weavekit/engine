/**
 * Low-level observability contract (protocol-neutral).
 *
 * The engine **emits** metrics and finished spans through these sinks; it does
 * NOT ship a backend, dashboard, alerting or exporter — those are product /
 * enterprise concerns (see the enterprise-seams reference). The default is a
 * no-op, so telemetry has zero overhead unless a host injects a sink.
 *
 * Label discipline (contract): label values MUST be low-cardinality and
 * PII-free. Never put tenant data, record ids, SQL text, credentials or other
 * secrets in labels — those belong in the (audited) data path, not in metrics.
 */

/** engine metric names — single source of truth (see AGENTS.md: no ad-hoc literals) */
export const METRIC_NAMES = {
  /** HTTP request duration in ms (histogram); labels: method, route, status */
  HTTP_REQUEST_DURATION_MS: 'http.request.duration_ms',
  /** HTTP response count (counter); labels: method, route, status */
  HTTP_RESPONSE: 'http.response',
  /** RBAC denial (counter); labels: object, action */
  RBAC_DENY: 'rbac.deny',
  /** audit event persisted (counter); labels: mode */
  AUDIT_SUCCESS: 'audit.success',
  /** audit persistence failure (counter); labels: mode */
  AUDIT_FAILURE: 'audit.failure',
  /** query rejected by the query budget (counter); labels: object, limit */
  QUERY_BUDGET_REJECT: 'query.budget.reject',
  /** pool clients by state (gauge); labels: state (idle|waiting|total) */
  POOL_STATE: 'pool.state',
  /** tool/workflow execution latency in ms (histogram); labels: kind */
  EXECUTION_DURATION_MS: 'execution.duration_ms',
} as const;
export type MetricName = typeof METRIC_NAMES[keyof typeof METRIC_NAMES];

/** low-cardinality, PII-free metric labels (see the label-discipline contract above) */
export type MetricLabels = Record<string, string>;

/** metric emission seam — implement once per telemetry backend (OTel/Prometheus/…); must not throw into the caller */
export interface MetricsSink {
  /** monotonically increasing counter (default increment 1) */
  counter(name: MetricName, value?: number, labels?: MetricLabels): void;
  /** instantaneous value (last-write-wins) */
  gauge(name: MetricName, value: number, labels?: MetricLabels): void;
  /** distribution observation (e.g. a latency in ms) */
  histogram(name: MetricName, value: number, labels?: MetricLabels): void;
}

/** a finished, protocol-neutral span (the engine does not manage span lifecycles) */
export interface TraceSpan {
  name: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  status: 'ok' | 'error';
  /** low-cardinality, PII-free attributes (same discipline as metric labels) */
  attributes?: MetricLabels;
}

/** trace emission seam — the engine records finished spans; correlation uses the inbound traceparent */
export interface TraceSink {
  recordSpan(span: TraceSpan): void;
}

/** discard everything (telemetry disabled) */
export const NOOP_METRICS_SINK: MetricsSink = {
  counter: () => {},
  gauge: () => {},
  histogram: () => {},
};

export const NOOP_TRACE_SINK: TraceSink = {
  recordSpan: () => {},
};

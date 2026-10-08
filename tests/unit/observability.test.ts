import { describe, it, expect } from '../helpers/test.js';
import {
  METRIC_NAMES,
  NOOP_METRICS_SINK,
  NOOP_TRACE_SINK,
  ObjectRegistry,
  systemPrincipal,
  userPrincipal,
  type MetricsSink,
} from '../../src/core/index.js';
import { createDataAccess, resolveQueryBudget, withRbac } from '../../src/runtime/data-access/index.js';

/** capture emitted metric names/values for assertions */
function capture(): { metrics: MetricsSink; counters: Array<{ name: string; labels?: Record<string, string> }> } {
  const counters: Array<{ name: string; labels?: Record<string, string> }> = [];
  return {
    counters,
    metrics: {
      counter: (name, _value, labels) => counters.push(labels === undefined ? { name } : { name, labels }),
      gauge: () => {},
      histogram: () => {},
    },
  };
}

describe('observability contract', () => {
  it('metric names are stable and unique', () => {
    const values = Object.values(METRIC_NAMES);
    expect(new Set(values).size).toBe(values.length);
    expect(METRIC_NAMES.RBAC_DENY).toBe('rbac.deny');
    expect(METRIC_NAMES.QUERY_BUDGET_REJECT).toBe('query.budget.reject');
    expect(METRIC_NAMES.HTTP_REQUEST_DURATION_MS).toBe('http.request.duration_ms');
  });

  it('no-op sinks accept every call without throwing', () => {
    expect(() => NOOP_METRICS_SINK.counter(METRIC_NAMES.RBAC_DENY)).not.toThrow();
    expect(() => NOOP_METRICS_SINK.gauge(METRIC_NAMES.POOL_STATE, 3)).not.toThrow();
    expect(() => NOOP_METRICS_SINK.histogram(METRIC_NAMES.EXECUTION_DURATION_MS, 12)).not.toThrow();
    expect(() =>
      NOOP_TRACE_SINK.recordSpan({
        name: 'GET /api/x',
        startedAt: new Date(),
        endedAt: new Date(),
        durationMs: 1,
        status: 'ok',
      }),
    ).not.toThrow();
  });

  it('withRbac emits rbac.deny (PII-free labels) on a permission denial', async () => {
    const reg = new ObjectRegistry();
    reg.register({
      name: 'doc',
      fields: [{ name: 'id', type: 'string', primary: true }],
      permissions: { viewer: { read: 'all' } },
    });
    const { metrics, counters } = capture();
    const da = withRbac(createDataAccess(), { metrics });
    let code: unknown;
    try {
      await da.find(
        'doc',
        {},
        { pool: {} as never, registry: reg, principal: userPrincipal({ id: 'u1', roles: ['nobody'] }) },
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('rbac.denied.read');
    const deny = counters.find((c) => c.name === METRIC_NAMES.RBAC_DENY);
    expect(deny).toBeDefined();
    expect(deny?.labels).toEqual({ object: 'doc', action: 'read' });
  });

  it('data-access emits query.budget.reject when the budget is exceeded', async () => {
    const reg = new ObjectRegistry();
    reg.register({
      name: 'doc',
      fields: [
        { name: 'id', type: 'string', primary: true },
        { name: 'a', type: 'string' },
        { name: 'b', type: 'string' },
      ],
    });
    const { metrics, counters } = capture();
    const da = createDataAccess({ metrics, budget: resolveQueryBudget({ maxFilters: 1 }) });
    let code: unknown;
    try {
      await da.find(
        'doc',
        { filter: { a: '1', b: '2' } },
        { pool: {} as never, registry: reg, principal: systemPrincipal('internal.admin') },
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('query.budget.exceeded');
    const reject = counters.find((c) => c.name === METRIC_NAMES.QUERY_BUDGET_REJECT);
    expect(reject).toBeDefined();
    expect(reject?.labels?.object).toBe('doc');
  });
});

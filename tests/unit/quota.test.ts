import { describe, it, expect } from '../helpers/test.js';
import {
  assertQuota,
  consumeQuota,
  COUNTER_PERIODS,
  periodBounds,
  type CounterStore,
} from '../../src/core/index.js';

/** trivial in-memory CounterStore for the pure quota tests */
function memoryStore(): CounterStore {
  const counts = new Map<string, number>();
  const k = (key: string, start: Date): string => `${key}@${start.toISOString()}`;
  return {
    async consume(key, amount, limit, periodStart) {
      const id = k(key, periodStart);
      const current = counts.get(id) ?? 0;
      if (current + amount > limit || amount > limit) return { allowed: false, value: current };
      const next = current + amount;
      counts.set(id, next);
      return { allowed: true, value: next };
    },
    async value(key, periodStart) {
      return counts.get(k(key, periodStart)) ?? 0;
    },
  };
}

describe('quota — periodBounds', () => {
  it('day bounds are UTC midnight → next midnight', () => {
    const { start, resetAt } = periodBounds(new Date('2026-03-15T13:45:00Z'), COUNTER_PERIODS.DAY);
    expect(start.toISOString()).toBe('2026-03-15T00:00:00.000Z');
    expect(resetAt.toISOString()).toBe('2026-03-16T00:00:00.000Z');
  });

  it('month bounds are the 1st → next month 1st (UTC)', () => {
    const { start, resetAt } = periodBounds(new Date('2026-12-31T23:59:59Z'), COUNTER_PERIODS.MONTH);
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(resetAt.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('quota — consumeQuota / assertQuota', () => {
  const now = new Date('2026-03-15T10:00:00Z');

  it('consumes within budget and reports remaining', async () => {
    const store = memoryStore();
    const decision = await consumeQuota(store, 'dingtalk', { limit: 3, period: COUNTER_PERIODS.MONTH }, 1, now);
    expect(decision.allowed).toBe(true);
    expect(decision.value).toBe(1);
    expect(decision.remaining).toBe(2);
  });

  it('denies once the budget is exhausted and leaves the counter untouched', async () => {
    const store = memoryStore();
    const policy = { limit: 2, period: COUNTER_PERIODS.MONTH } as const;
    await consumeQuota(store, 'k', policy, 1, now);
    await consumeQuota(store, 'k', policy, 1, now);
    const denied = await consumeQuota(store, 'k', policy, 1, now);
    expect(denied.allowed).toBe(false);
    expect(denied.value).toBe(2);
    expect(denied.remaining).toBe(0);
  });

  it('counters are isolated per period', async () => {
    const store = memoryStore();
    const policy = { limit: 1, period: COUNTER_PERIODS.DAY } as const;
    expect((await consumeQuota(store, 'k', policy, 1, now)).allowed).toBe(true);
    const nextDay = new Date('2026-03-16T00:00:01Z');
    expect((await consumeQuota(store, 'k', policy, 1, nextDay)).allowed).toBe(true);
  });

  it('assertQuota throws a localized quota.exceeded', async () => {
    const store = memoryStore();
    const policy = { limit: 1, period: COUNTER_PERIODS.DAY } as const;
    await assertQuota(store, 'k', policy, 'en', 1, now);
    await expect(assertQuota(store, 'k', policy, 'en', 1, now)).rejects.toThrow(/quota exceeded/);
  });
});

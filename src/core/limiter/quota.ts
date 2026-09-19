import type { Locale } from '../i18n/index.js';
import { SchemaError } from '../types/errors.js';
import { COUNTER_PERIODS, type CounterPeriod, type CounterStore } from './counter.js';

/**
 * Pure quota/budget evaluation on top of a {@link CounterStore}. A quota is a
 * hard period budget (e.g. "10000 integration calls per month"), which is a
 * different product capability from the in-memory sliding-window rate limiter
 * (`sliding-window.ts`): rate = request velocity, quota = durable spend.
 */

/** a fixed-period budget policy */
export interface QuotaPolicy {
  /** maximum amount allowed per period */
  limit: number;
  /** accounting period (UTC boundaries) */
  period: CounterPeriod;
}

/** the result of consuming against a policy */
export interface QuotaDecision {
  /** true when the amount was within budget and has been consumed */
  allowed: boolean;
  limit: number;
  /** value after a successful consume (unchanged when denied) */
  value: number;
  /** budget left after this decision (never negative) */
  remaining: number;
  /** inclusive start of the current period (UTC) */
  periodStart: Date;
  /** exclusive start of the next period (UTC) */
  resetAt: Date;
}

/** the [start, resetAt) bounds of the period containing `now` (UTC). */
export function periodBounds(now: Date, period: CounterPeriod): { start: Date; resetAt: Date } {
  if (period === COUNTER_PERIODS.MONTH) {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { start, resetAt };
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const resetAt = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, resetAt };
}

/**
 * Consume `amount` (default 1) against `policy`; never throws — inspect
 * `allowed`. Use this when the caller wants to decide what a denial means.
 */
export async function consumeQuota(
  store: CounterStore,
  key: string,
  policy: QuotaPolicy,
  amount = 1,
  now: Date = new Date(),
): Promise<QuotaDecision> {
  const { start, resetAt } = periodBounds(now, policy.period);
  const { allowed, value } = await store.consume(key, amount, policy.limit, start);
  return {
    allowed,
    limit: policy.limit,
    value,
    remaining: Math.max(0, policy.limit - value),
    periodStart: start,
    resetAt,
  };
}

/**
 * Consume or throw a localized `quota.exceeded` (429-family). The natural
 * opt-in enforcement point for an outbound integration call.
 */
export async function assertQuota(
  store: CounterStore,
  key: string,
  policy: QuotaPolicy,
  locale: Locale,
  amount = 1,
  now?: Date,
): Promise<QuotaDecision> {
  const decision = await consumeQuota(store, key, policy, amount, now);
  if (!decision.allowed) {
    throw new SchemaError('quota.exceeded', { key, limit: policy.limit, period: policy.period }, locale);
  }
  return decision;
}

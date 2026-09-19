/**
 * Durable fixed-period counter contract — the mechanism behind quotas and
 * usage budgets. Pure interface (zero dependencies); the PG implementation
 * lives in `subsystems/quota` and is injected by the assembly layer, mirroring
 * `ApprovalsBackend`.
 *
 * The engine owns atomicity and storage; the application owns the semantics
 * (which key, which limit, which period) — it calls `consume` around its own
 * outbound/integration work. Quota keys are opaque to the engine.
 */

/** supported fixed accounting periods (UTC boundaries) */
export const COUNTER_PERIODS = {
  DAY: 'day',
  MONTH: 'month',
} as const;
export type CounterPeriod = typeof COUNTER_PERIODS[keyof typeof COUNTER_PERIODS];

/** outcome of an atomic {@link CounterStore.consume} */
export interface CounterConsume {
  /** true when the increment was applied (`value + amount` stayed within `limit`) */
  allowed: boolean;
  /** the stored value (after a successful increment, or unchanged when denied) */
  value: number;
}

/**
 * Fixed-period counters keyed by an arbitrary string. Implementations MUST make
 * `consume` atomic and safe across engine instances (single-statement compare +
 * increment), so a multi-instance deployment cannot overspend a budget.
 */
export interface CounterStore {
  /**
   * Atomically add `amount` to `key` in the period starting at `periodStart`,
   * applying it only when the result stays `<= limit`. A denied consume leaves
   * the counter untouched.
   */
  consume(key: string, amount: number, limit: number, periodStart: Date): Promise<CounterConsume>;
  /** current value for `key` in the period starting at `periodStart` (0 when absent). */
  value(key: string, periodStart: Date): Promise<number>;
}

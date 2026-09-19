import type { Pool } from 'pg';
import type { CounterConsume, CounterStore } from '../../core/limiter/index.js';

/**
 * PostgreSQL-backed {@link CounterStore} (MIT, ships with the engine).
 *
 * One table, keyed by `(key, period_start)`. `consume` is a single atomic
 * `INSERT … ON CONFLICT DO UPDATE … WHERE value + amount <= limit RETURNING`,
 * so concurrent engine instances cannot overspend a budget. Counters live in
 * the same database as the business data (no extra infrastructure); a future
 * Redis/cloud backend can be injected behind the same contract.
 */

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS weavekit_counters (
  key text NOT NULL,
  period_start timestamptz NOT NULL,
  value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, period_start)
)`;

export async function createPgCounterStore(pool: Pool): Promise<CounterStore> {
  await pool.query(CREATE_TABLE);

  async function value(key: string, periodStart: Date): Promise<number> {
    const res = await pool.query<{ value: string }>(
      'SELECT value FROM weavekit_counters WHERE key = $1 AND period_start = $2',
      [key, periodStart],
    );
    return res.rows.length === 0 ? 0 : Number(res.rows[0]!.value);
  }

  return {
    async consume(key: string, amount: number, limit: number, periodStart: Date): Promise<CounterConsume> {
      if (amount <= 0) return { allowed: true, value: await value(key, periodStart) };
      if (amount > limit) return { allowed: false, value: await value(key, periodStart) };
      const res = await pool.query<{ value: string }>(
        `INSERT INTO weavekit_counters (key, period_start, value)
         VALUES ($1, $2, $3)
         ON CONFLICT (key, period_start)
         DO UPDATE SET value = weavekit_counters.value + EXCLUDED.value, updated_at = now()
         WHERE weavekit_counters.value + EXCLUDED.value <= $4
         RETURNING value`,
        [key, periodStart, amount, limit],
      );
      if (res.rows.length === 0) {
        // the conflict branch was rejected by the WHERE guard (budget exhausted)
        return { allowed: false, value: await value(key, periodStart) };
      }
      return { allowed: true, value: Number(res.rows[0]!.value) };
    },
    value,
  };
}

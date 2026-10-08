import { SchemaError } from '../../core/index.js';
import type { Locale } from '../../core/index.js';
import type { Filter, FindOptions } from './types.js';
import { PAGINATION } from './values.js';

/**
 * Agent-native query budget — a single object bounding what one read/query may
 * cost. Enforced across data-access (`find`), restricted SQL (`this.db.query`)
 * and protocol adapters (GraphQL depth, MCP row cap), so a caller cannot bypass
 * a limit by switching protocol. `as const` defaults are the single source of
 * truth (AGENTS: no hardcoded unions).
 */
export interface QueryBudget {
  /** maximum rows returned by a list/find (MCP/REST/GraphQL row cap) */
  maxRows: number;
  /** maximum GraphQL selection depth */
  maxDepth: number;
  /** maximum JOINs in a restricted SQL query */
  maxJoins: number;
  /** maximum filter conditions in a list query (incl. `$or` members) */
  maxFilters: number;
  /** maximum sort keys in a list query */
  maxSorts: number;
  /** maximum restricted-SQL statement length (characters) */
  maxSqlLength: number;
  /** per-query database `statement_timeout` (ms) */
  statementTimeoutMs: number;
}

/** default budget (single source of truth) */
export const QUERY_BUDGET_DEFAULTS = {
  maxRows: PAGINATION.MAX_LIMIT,
  maxDepth: 10,
  maxJoins: 8,
  maxFilters: 50,
  maxSorts: 8,
  maxSqlLength: 20_000,
  statementTimeoutMs: 5_000,
} as const satisfies QueryBudget;

/** positive integer or the fallback */
function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** merge a partial config over the defaults (invalid/absent values fall back) */
export function resolveQueryBudget(partial?: Partial<QueryBudget>): QueryBudget {
  if (partial === undefined) return { ...QUERY_BUDGET_DEFAULTS };
  return {
    maxRows: positive(partial.maxRows, QUERY_BUDGET_DEFAULTS.maxRows),
    maxDepth: positive(partial.maxDepth, QUERY_BUDGET_DEFAULTS.maxDepth),
    maxJoins: positive(partial.maxJoins, QUERY_BUDGET_DEFAULTS.maxJoins),
    maxFilters: positive(partial.maxFilters, QUERY_BUDGET_DEFAULTS.maxFilters),
    maxSorts: positive(partial.maxSorts, QUERY_BUDGET_DEFAULTS.maxSorts),
    maxSqlLength: positive(partial.maxSqlLength, QUERY_BUDGET_DEFAULTS.maxSqlLength),
    statementTimeoutMs: positive(partial.statementTimeoutMs, QUERY_BUDGET_DEFAULTS.statementTimeoutMs),
  };
}

function exceeded(limit: string, max: number, locale?: Locale): never {
  throw new SchemaError('query.budget.exceeded', { limit, max }, locale);
}

/** count filter conditions, expanding `$or` groups into their member conditions */
export function countFilterConditions(filter: Filter | undefined): number {
  if (filter === undefined || filter === null || typeof filter !== 'object') return 0;
  let count = 0;
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$or' && Array.isArray(value)) {
      for (const group of value) {
        if (group !== null && typeof group === 'object' && !Array.isArray(group)) {
          count += Object.keys(group).length;
        }
      }
    } else {
      count += 1;
    }
  }
  return count;
}

/** fail-closed when a `find` option set exceeds the budget */
export function assertQueryBudget(opts: FindOptions, budget: QueryBudget, locale?: Locale): void {
  const filters = countFilterConditions(opts.filter);
  if (filters > budget.maxFilters) exceeded('filters', budget.maxFilters, locale);
  const sorts = opts.sort?.length ?? 0;
  if (sorts > budget.maxSorts) exceeded('sorts', budget.maxSorts, locale);
}

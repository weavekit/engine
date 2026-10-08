import type { QueryResult, QueryResultRow } from 'pg';

/**
 * Minimal SQL query surface shared by `pg`'s `Pool` and `PoolClient`, so core
 * storage helpers (`meta`/`migrate`) can run either standalone or **inside a
 * caller's transaction** (the atomic deploy threads one client through DDL +
 * metadata cache + revision).
 *
 * Distinct from `runtime/data-access`'s `Queryable` (`Pool | PoolClient`) to
 * avoid a name clash when both are re-exported from the package root.
 */
export interface SqlQueryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

import { SchemaError } from '../../core/index.js';
import type { Locale } from '../../core/index.js';
import { parse } from 'pgsql-parser';
import { walk } from '@pgsql/traverse';

/**
 * SQL analyzer — PostgreSQL query analysis for the script sandbox's restricted
 * SQL (`this.db.query`) and, later, any consumer that needs to understand the
 * tables/columns a query references.
 *
 * Parsing is done by `pgsql-parser` (a WASM build of PostgreSQL's own parser,
 * `libpg_query`), so a query that parses here is guaranteed valid PG syntax —
 * the parser and the database share a grammar. The analyzer is **fail-closed**:
 * any parse error, multi-statement input, or non-SELECT statement throws
 * `script.query.invalid`, so the caller can never run SQL the analyzer does not
 * fully understand.
 *
 * The returned column references cover the whole statement tree (target list,
 * WHERE/HAVING, ORDER BY, GROUP BY, join conditions, subqueries) because the
 * AST walk visits every `ColumnRef` regardless of position. The AST also
 * disambiguates what a string scan cannot: a projection `*`/`t.*` is a
 * `ColumnRef` with `A_Star`, while `count(*)` is a `FuncCall` `agg_star` flag
 * and produces no column reference at all.
 */

export interface SqlColumnRef {
  /** table alias or table name (the `ColumnRef` qualifier); undefined for bare columns */
  qualifier?: string;
  /** column name, or `'*'` for a star reference (`*` / `t.*`) */
  column: string;
  /** whether this reference is a star */
  star: boolean;
}

export interface SqlAnalysis {
  /** distinct referenced table names (`RangeVar.relname`) */
  tables: string[];
  /** alias → table-name map (table names map to themselves) for qualifier resolution */
  resolvers: Record<string, string>;
  /** every column reference in the statement (target/where/order/group/having/joins/subqueries) */
  columnRefs: SqlColumnRef[];
}

export interface SqlAnalyzer {
  /** warm up the WASM module (engine startup preload — avoids cold start on first use) */
  ensureLoaded(): Promise<void>;
  /**
   * Parse + analyze exactly one SELECT statement.
   * @throws SchemaError('script.query.invalid') on parse error, multi-statement input, or non-SELECT
   */
  analyzeSelect(sql: string, locale?: Locale): Promise<SqlAnalysis>;
}

interface ColumnField {
  String?: { sval: string };
  A_Star?: unknown;
}

export function createSqlAnalyzer(): SqlAnalyzer {
  // `parse` awaits the WASM module init on first call — preloading with a
  // trivial probe removes the cold start from the first real db.query.
  let loaded: Promise<void> | undefined;

  return {
    async ensureLoaded() {
      if (loaded === undefined) {
        loaded = parse('SELECT 1').then(() => undefined);
      }
      await loaded;
    },

    async analyzeSelect(sql, locale) {
      let ast: { stmts?: Array<{ stmt?: Record<string, unknown> }> };
      try {
        ast = await parse(sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SchemaError('script.query.invalid', { detail: message }, locale);
      }
      const stmts = ast.stmts ?? [];
      if (stmts.length !== 1) {
        throw new SchemaError('script.query.invalid', { detail: 'exactly one statement is allowed' }, locale);
      }
      if (stmts[0]?.stmt?.SelectStmt === undefined) {
        throw new SchemaError('script.query.invalid', { detail: 'only SELECT statements are allowed' }, locale);
      }

      const tables: string[] = [];
      const resolvers: Record<string, string> = {};
      const columnRefs: SqlColumnRef[] = [];

      walk(ast, {
        RangeVar: (path) => {
          const node = path.node as { relname?: string; alias?: { aliasname?: string } };
          if (node.relname === undefined) return;
          tables.push(node.relname);
          resolvers[node.relname] = node.relname;
          if (node.alias?.aliasname !== undefined) resolvers[node.alias.aliasname] = node.relname;
        },
        ColumnRef: (path) => {
          const node = path.node as { fields?: ColumnField[] };
          const fields = node.fields ?? [];
          const quals = fields.filter((f) => f.String !== undefined).map((f) => f.String!.sval);
          const star = fields.some((f) => f.A_Star !== undefined);
          columnRefs.push(
            star
              ? { qualifier: quals.length >= 1 ? quals[0] : undefined, column: '*', star: true }
              : { qualifier: quals.length > 1 ? quals[0] : undefined, column: quals[quals.length - 1] ?? '', star: false },
          );
        },
      });

      return { tables: [...new Set(tables)], resolvers, columnRefs };
    },
  };
}

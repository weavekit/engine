import { SchemaError, resolvePermission } from '../../core/index.js';
import { READ_SCOPES } from '../../core/index.js';
import type { Locale, ObjectDefinition, ObjectRegistry } from '../../core/index.js';
import type { SqlAnalysis } from '../sql-analyzer/index.js';

/**
 * RBAC gates for restricted SQL (`this.db.query`), run before execution.
 *
 * Layered on top of the SQL analyzer's authoritative table/column references
 * and the core RBAC decision layer (`resolvePermission` / `buildRowScope`):
 *
 * 1. **read permission** — the subject must have a read permission on every
 *    referenced object table (deterministic error instead of a silent 0 rows).
 * 2. **team scope** — a `team`-read object requires `subject.teamId`.
 * 3. **field `exclude`** (fine-grained, column-level) — a query that references
 *    an excluded column of a field-restricted object is rejected:
 *    - a star (`*` / `t.*`) over a field-restricted object
 *    - a qualified column reference (`t.excluded`) to an excluded field
 *    - a bare column that matches an excluded field of any referenced
 *      field-restricted object (conservative — we cannot resolve bare columns
 *      to a table without schema knowledge, so we over-block rather than leak)
 *
 * Row-level scoping is handled separately by PostgreSQL RLS (see the C2 design);
 * this module is the permission + column boundary in the application layer.
 * All failures are `script.query.denied` (403) except missing `teamId`, which is
 * the existing `rbac.teamId.missing`.
 */
export interface SqlGateOptions {
  analysis: SqlAnalysis;
  registry: ObjectRegistry;
  /** subject role names (resolved permission derives the read scope + exclusions) */
  roles: readonly string[];
  /** subject team id, required when a referenced object's read scope is `team` */
  teamId?: string;
  locale?: Locale;
}

function denied(object: string, detail: string, locale?: Locale): never {
  throw new SchemaError('script.query.denied', { object, detail }, locale);
}

export function enforceSqlGates(options: SqlGateOptions): void {
  const { analysis, registry, roles, teamId, locale } = options;

  // fail-closed: every referenced table must be an engine-managed object.
  // A table outside the registry has no RBAC policy and no RLS strategy, so
  // letting the query through would bypass the permission model entirely
  // (e.g. system tables, other schemas, or the customer's own ad-hoc tables).
  for (const table of analysis.tables) {
    if (registry.get(table) === undefined) {
      denied(table, 'table is not a managed object', locale);
    }
  }

  // referenced object tables (registry-known) → resolved permission
  const objects = new Map<string, ObjectDefinition>();
  for (const table of analysis.tables) {
    const def = registry.get(table);
    if (def !== undefined) objects.set(table, def);
  }

  // excluded fields per referenced object (empty set = not field-restricted)
  const excludedByTable = new Map<string, Set<string>>();
  for (const [name, def] of objects) {
    const p = resolvePermission(def, roles);
    if (p === undefined || p.read === undefined) {
      denied(name, 'role has no read permission on this object', locale);
    }
    if (p.read === READ_SCOPES.TEAM && teamId === undefined) {
      throw new SchemaError('rbac.teamId.missing', { object: name }, locale);
    }
    if (p.exclude !== undefined && p.exclude.length > 0) {
      excludedByTable.set(name, new Set(p.exclude));
    }
  }

  if (excludedByTable.size === 0) return;

  for (const ref of analysis.columnRefs) {
    if (ref.star) {
      // star: qualified star resolves to one table; bare star covers all FROM tables
      const tables =
        ref.qualifier !== undefined ? [analysis.resolvers[ref.qualifier]] : analysis.tables;
      for (const table of tables) {
        if (table !== undefined && excludedByTable.has(table)) {
          denied(table, 'field-restricted object cannot be selected with *', locale);
        }
      }
    } else if (ref.qualifier !== undefined) {
      const table = analysis.resolvers[ref.qualifier];
      if (table !== undefined) {
        const excluded = excludedByTable.get(table);
        if (excluded !== undefined && excluded.has(ref.column)) {
          denied(table, `field "${ref.column}" is restricted for this role`, locale);
        }
      }
    } else {
      // bare column — conservative: if it matches an excluded field of any
      // referenced field-restricted object, reject (it may be that object's column)
      for (const [table, excluded] of excludedByTable) {
        if (excluded.has(ref.column)) {
          denied(table, `field "${ref.column}" is restricted for this role`, locale);
        }
      }
    }
  }
}

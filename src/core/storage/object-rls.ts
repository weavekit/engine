import type { ObjectRegistry } from '../object/index.js';
import { SYSTEM_OBJECT_NAMES, systemObjects } from '../object/index.js';
import { buildObjectRlsPolicies, OBJECT_RLS_POLICIES } from '../rbac/index.js';
import { diffGrants, diffObjectRls } from './diff.js';
import type { ActualTable } from './inspect.js';
import { buildLinkTables } from './link-table.js';
import { recordMetaTableName } from './record-meta.js';

/** customer tables: the role reads/updates/deletes under the generated policies (INSERT stays with the owner) */
const OBJECT_PRIVILEGES = ['SELECT', 'UPDATE', 'DELETE'] as const;

export interface ObjectRlsPlan {
  statements: string[];
  /** objects whose existing table cannot take RLS (not opted into `alter`, or not owned by the migrating role) */
  skipped: string[];
}

/**
 * Plan the object-path RLS DDL (`EngineConfig.rls.enforce`) for every registry
 * object: per-table policies + privileges for `role`, plus read access to the
 * engine tables the scoped queries touch (identity directory for department /
 * external-id scopes, record-metadata side tables, multiRelation link tables).
 *
 * With `owner` (migrate), an existing table is only touched when the object
 * opted into `alter` and `owner` owns it — enabling RLS on a shared customer
 * table would also hide its rows from other non-owner roles. Without `owner`
 * (startup / doctor check) every object is planned, so any remaining statement
 * means the database is not provisioned.
 */
export function planObjectRls(
  registry: ObjectRegistry,
  actual: ReadonlyMap<string, ActualTable>,
  role: string,
  options: { owner?: string } = {},
): ObjectRlsPlan {
  const statements: string[] = [];
  const skipped: string[] = [];
  for (const def of registry.list()) {
    const table = actual.get(def.name);
    if (table !== undefined && options.owner !== undefined && !(def.alter === true && table.owner === options.owner)) {
      skipped.push(def.name);
      continue;
    }
    statements.push(...diffObjectRls(def.name, table, role, buildObjectRlsPolicies(registry, def), OBJECT_PRIVILEGES));
    const meta = recordMetaTableName(def.name);
    statements.push(...diffGrants(meta, actual.get(meta), role, ['SELECT']));
  }
  for (const name of SYSTEM_OBJECT_NAMES) {
    statements.push(...diffGrants(name, actual.get(name), role, ['SELECT']));
  }
  const defs = new Map([...systemObjects(), ...registry.list()].map((d) => [d.name, d]));
  // link rows are scoped by the target-visibility predicate the query carries
  const linkPolicy = [{ name: OBJECT_RLS_POLICIES.SELECT, command: 'SELECT' as const, using: 'true' }];
  for (const link of buildLinkTables(defs, registry.fieldTypes)) {
    statements.push(...diffObjectRls(link.name, actual.get(link.name), role, linkPolicy, ['SELECT']));
  }
  return { statements, skipped };
}

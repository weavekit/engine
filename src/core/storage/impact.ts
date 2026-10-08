import { ROW_SCOPE_MARKERS } from '../types/index.js';
import type { ObjectDefinition } from '../types/index.js';

/**
 * Schema-impact analysis over the DDL a `deploy plan` **would** run. Pure and
 * read-only: classifies the engine-generated statements (creates / column adds /
 * constraints / indexes / enum + RLS changes) and derives a coarse data-
 * compatibility risk, RBAC/tenant impact and an API-breaking flag. Engine DDL is
 * additive-only, so `apiBreaking` is expected to stay false (it is a guard, not
 * a promise about hand-written SQL).
 */

export const IMPACT_RISKS = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const;
export type ImpactRisk = typeof IMPACT_RISKS[keyof typeof IMPACT_RISKS];

export interface ColumnAdd {
  object: string;
  column: string;
  /** `ADD COLUMN … NOT NULL` without a DEFAULT — would fail on a non-empty table */
  notNullWithoutDefault: boolean;
}

export interface SchemaImpact {
  /** new tables */
  creates: string[];
  columnAdds: ColumnAdd[];
  /** `ALTER TABLE … ADD CONSTRAINT` */
  constraints: string[];
  /** `CREATE INDEX … ON table` (index name) */
  indexes: string[];
  /** native enum type changes (`CREATE TYPE` / `ALTER TYPE … ADD VALUE`) */
  enumChanges: string[];
  /** RLS policy/enable changes (`ALTER TABLE … ENABLE ROW LEVEL SECURITY`, `CREATE/DROP POLICY`) */
  rlsChanges: string[];
  /** destructive statements (drop/rename/type-change) — none from the engine today */
  drops: string[];
  dataCompat: { risk: ImpactRisk; notes: string[] };
  rbacTenant: { tenantObjects: string[]; permissionObjects: string[] };
  /** true when a statement could break an existing API/schema consumer */
  apiBreaking: boolean;
}

const CREATE_TABLE = /^CREATE TABLE "([^"]+)"/;
const ADD_COLUMN = /^ALTER TABLE "([^"]+)" ADD COLUMN "([^"]+)" (.+?);?$/;
const ADD_CONSTRAINT = /^ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+)"/;
const CREATE_INDEX = /^CREATE INDEX "([^"]+)"/;
const ENUM_CHANGE = /^(?:CREATE TYPE|ALTER TYPE) "([^"]+)"/;
const RLS_CHANGE = /(?:ENABLE ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY)/;
const DESTRUCTIVE = /\b(DROP\s+(?:TABLE|COLUMN)|RENAME\s+(?:TO|COLUMN))\b/i;
/** the first quoted identifier is the statement's subject (table or index name) */
const FIRST_QUOTED = /"([^"]+)"/;

/** engine plumbing (`weavekit_*` system + per-object metadata tables) is not user-schema impact */
function isSystemSubject(stmt: string): boolean {
  const subject = FIRST_QUOTED.exec(stmt)?.[1];
  return subject !== undefined && subject.startsWith('weavekit_');
}

function objectOf(def: ObjectDefinition): { tenant: boolean; permissions: boolean } {
  const tenant = def.fields.some(
    (field) => (field as unknown as Record<string, unknown>)[ROW_SCOPE_MARKERS.TENANT] === true,
  );
  return { tenant, permissions: Object.keys(def.permissions ?? {}).length > 0 };
}

/** analyze the planned DDL + the definitions of the objects it touches */
export function analyzeImpact(statements: readonly string[], changedDefs: readonly ObjectDefinition[]): SchemaImpact {
  const creates: string[] = [];
  const columnAdds: ColumnAdd[] = [];
  const constraints: string[] = [];
  const indexes: string[] = [];
  const enumChanges: string[] = [];
  const rlsChanges: string[] = [];
  const drops: string[] = [];

  for (const statement of statements) {
    const stmt = statement.trim();
    if (isSystemSubject(stmt)) continue; // engine plumbing, not user-schema impact
    if (DESTRUCTIVE.test(stmt)) {
      drops.push(stmt);
      continue;
    }
    const create = CREATE_TABLE.exec(stmt);
    if (create !== null) {
      creates.push(create[1]!);
      continue;
    }
    const addCol = ADD_COLUMN.exec(stmt);
    if (addCol !== null) {
      const rest = addCol[3]!;
      columnAdds.push({
        object: addCol[1]!,
        column: addCol[2]!,
        notNullWithoutDefault: /NOT NULL/.test(rest) && !/DEFAULT/.test(rest),
      });
      continue;
    }
    const constraint = ADD_CONSTRAINT.exec(stmt);
    if (constraint !== null) {
      constraints.push(constraint[2]!);
      continue;
    }
    const index = CREATE_INDEX.exec(stmt);
    if (index !== null) {
      indexes.push(index[1]!);
      continue;
    }
    const enumType = ENUM_CHANGE.exec(stmt);
    if (enumType !== null) {
      enumChanges.push(enumType[1]!);
      continue;
    }
    if (RLS_CHANGE.test(stmt)) rlsChanges.push(stmt);
  }

  const notes: string[] = [];
  let risk: ImpactRisk = IMPACT_RISKS.LOW;
  const escalate = (level: ImpactRisk): void => {
    const order: ImpactRisk[] = [IMPACT_RISKS.LOW, IMPACT_RISKS.MEDIUM, IMPACT_RISKS.HIGH];
    if (order.indexOf(level) > order.indexOf(risk)) risk = level;
  };
  const riskyColumns = columnAdds.filter((c) => c.notNullWithoutDefault);
  if (riskyColumns.length > 0) {
    escalate(IMPACT_RISKS.HIGH);
    notes.push(
      `ADD COLUMN NOT NULL without DEFAULT on ${riskyColumns.map((c) => `${c.object}.${c.column}`).join(', ')} — fails on a non-empty table`,
    );
  }
  if (drops.length > 0) {
    escalate(IMPACT_RISKS.HIGH);
    notes.push(`${drops.length} destructive statement(s) — potential data loss`);
  }
  if (constraints.length > 0) {
    escalate(IMPACT_RISKS.MEDIUM);
    notes.push(`${constraints.length} constraint(s) added — validated against existing data (may lock/fail if data violates)`);
  }
  if (columnAdds.length > 0 || indexes.length > 0) escalate(IMPACT_RISKS.MEDIUM);
  if (enumChanges.length > 0) {
    notes.push('enum value additions are irreversible (PostgreSQL cannot remove an enum label)');
  }

  const tenantObjects: string[] = [];
  const permissionObjects: string[] = [];
  for (const def of changedDefs) {
    const info = objectOf(def);
    if (info.tenant) tenantObjects.push(def.name);
    if (info.permissions) permissionObjects.push(def.name);
  }

  return {
    creates,
    columnAdds,
    constraints,
    indexes,
    enumChanges,
    rlsChanges,
    drops,
    dataCompat: { risk, notes },
    rbacTenant: { tenantObjects, permissionObjects },
    apiBreaking: drops.length > 0,
  };
}

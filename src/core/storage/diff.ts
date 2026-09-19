import type { ObjectDefinition } from '../types/index.js';
import { DETAILS_COLUMNS, FIELD_TYPES, primaryFieldOf, primaryKeyOf } from '../types/index.js';
import { SchemaError } from '../types/index.js';
import type { Locale } from '../i18n/index.js';
import { buildRlsGrantDdl, buildRlsPolicy, policyName } from '../rbac/index.js';
import { defaultExpr, onDeleteClause, pgType } from './map.js';
import type { ActualTable } from './inspect.js';

const q = (id: string) => `"${id}"`;

export interface ExpectedColumn {
  name: string;
  type: string;
  notNull: boolean;
  default?: string;
  primary: boolean;
  unique: boolean;
}

export interface ExpectedFk {
  column: string;
  refTable: string;
  refColumn: string;
  onDelete: string;
}

export interface ExpectedIndex {
  name: string;
  method: 'btree' | 'gin' | 'gist';
  columns: string[];
}

export interface ExpectedTable {
  name: string;
  columns: ExpectedColumn[];
  fks: ExpectedFk[];
  indexes: ExpectedIndex[];
}

/** mapped PK type of an object (for relation FK columns), or undefined */
function targetPkType(def: ObjectDefinition): string | undefined {
  const pkField = primaryFieldOf(def);
  return pkField === undefined ? undefined : pgType(pkField, undefined);
}

/**
 * Build the expected table spec for one object, resolving cross-object
 * information (relation FK target + type, details-child auto columns).
 */
export function buildExpectedTable(
  def: ObjectDefinition,
  defs: ReadonlyMap<string, ObjectDefinition>,
): ExpectedTable {
  const name = def.name;
  const columns: ExpectedColumn[] = [];
  const fks: ExpectedFk[] = [];
  const indexes: ExpectedIndex[] = [];

  for (const field of def.fields) {
    if (field.type === FIELD_TYPES.DETAILS) continue;

    let type: string;
    if (field.type === FIELD_TYPES.RELATION || field.type === FIELD_TYPES.PERSON || field.type === FIELD_TYPES.DEPARTMENT) {
      const targetDef = defs.get(field.target);
      type = targetDef === undefined ? 'VARCHAR(255)' : (targetPkType(targetDef) ?? 'VARCHAR(255)');
    } else {
      type = pgType(field, undefined);
    }

    columns.push({
      name: field.name,
      type,
      notNull: (field as { required?: boolean }).required === true || field.primary === true,
      default: defaultExpr(field),
      primary: field.primary === true,
      unique: (field as { unique?: boolean }).unique === true,
    });

    if (field.type === FIELD_TYPES.RELATION || field.type === FIELD_TYPES.PERSON || field.type === FIELD_TYPES.DEPARTMENT) {
      const targetDef = defs.get(field.target);
      const refColumn = targetDef === undefined ? undefined : primaryKeyOf(targetDef);
      if (refColumn !== undefined && targetDef !== undefined) {
        fks.push({
          column: field.name,
          refTable: targetDef.name,
          refColumn,
          onDelete: field.onDelete ?? 'restrict',
        });
      }
      indexes.push({ name: `${name}_${field.name}_idx`, method: 'btree', columns: [field.name] });
    } else if (field.type === FIELD_TYPES.ENUM) {
      const multiple = (field as { multiple?: boolean }).multiple === true;
      indexes.push({
        name: `${name}_${field.name}_idx`,
        method: multiple ? 'gin' : 'btree',
        columns: [field.name],
      });
    } else if (field.type === FIELD_TYPES.IMAGE) {
      const multiple = (field as { multiple?: boolean }).multiple === true;
      indexes.push({
        name: `${name}_${field.name}_idx`,
        method: multiple ? 'gin' : 'btree',
        columns: [field.name],
      });
    } else if (field.type === FIELD_TYPES.MULTI_RELATION) {
      indexes.push({ name: `${name}_${field.name}_idx`, method: 'gin', columns: [field.name] });
    }
  }

  const isDetailsChild = [...defs.values()].some((other) =>
    other.fields.some((f) => f.type === FIELD_TYPES.DETAILS && f.target === def.name),
  );
  if (isDetailsChild) {
    columns.push(
      { name: DETAILS_COLUMNS.PARENT_ID, type: 'VARCHAR(255)', notNull: true, primary: false, unique: false },
      { name: DETAILS_COLUMNS.PARENT_TYPE, type: 'VARCHAR(255)', notNull: true, primary: false, unique: false },
      { name: DETAILS_COLUMNS.PARENT_IDX, type: 'INTEGER', notNull: true, default: '1', primary: false, unique: false },
    );
    indexes.push({ name: `${name}_parent_idx`, method: 'btree', columns: [DETAILS_COLUMNS.PARENT_TYPE, DETAILS_COLUMNS.PARENT_ID] });
  }

  for (const idx of def.indexes ?? []) {
    indexes.push({ name: `${name}_${idx.fields.join('_')}_idx`, method: idx.type, columns: idx.fields });
  }

  return { name, columns, fks, indexes };
}

function createTableSql(t: ExpectedTable): string {
  const lines = t.columns.map((c) => {
    let sql = `  ${q(c.name)} ${c.type}`;
    if (c.default !== undefined) sql += ` DEFAULT ${c.default}`;
    if (c.notNull) sql += ' NOT NULL';
    return sql;
  });
  const pkCols = t.columns.filter((c) => c.primary).map((c) => c.name);
  if (pkCols.length > 0) {
    lines.push(`  CONSTRAINT ${q(`${t.name}_pkey`)} PRIMARY KEY (${pkCols.map(q).join(', ')})`);
  }
  for (const c of t.columns.filter((col) => col.unique)) {
    lines.push(`  CONSTRAINT ${q(`${t.name}_${c.name}_key`)} UNIQUE (${q(c.name)})`);
  }
  return `CREATE TABLE ${q(t.name)} (\n${lines.join(',\n')}\n);`;
}

/** statements to bring one expected table in line with the actual table (undefined = missing) */
export function diffTable(t: ExpectedTable, actual: ActualTable | undefined, locale?: Locale): string[] {
  const statements: string[] = [];
  const constraintAdds: string[] = [];
  const indexAdds: string[] = [];

  if (actual === undefined) {
    statements.push(createTableSql(t));
  } else {
    const actualCols = new Set(actual.columns.map((c) => c.name));
    for (const c of t.columns) {
      if (!actualCols.has(c.name)) {
        // additive safety invariant: adding a NOT NULL column to an existing
        // table without a DEFAULT fails on any non-empty table in PostgreSQL —
        // refuse loudly instead of emitting DDL that is guaranteed to break.
        // Primary-key columns are excluded: their absence is a misconfiguration
        // reported distinctly by migrate (object.primary.columnMissing).
        if (c.notNull && c.default === undefined && !c.primary) {
          throw new SchemaError('storage.alter.requiredNoDefault', { object: t.name, column: c.name }, locale);
        }
        let sql = `ALTER TABLE ${q(t.name)} ADD COLUMN ${q(c.name)} ${c.type}`;
        if (c.default !== undefined) sql += ` DEFAULT ${c.default}`;
        if (c.notNull) sql += ' NOT NULL';
        statements.push(`${sql};`);
      }
    }

    const pkCols = t.columns.filter((c) => c.primary).map((c) => c.name);
    if (pkCols.length > 0 && !pkCols.every((col) => actual.pk.includes(col))) {
      constraintAdds.push(`ALTER TABLE ${q(t.name)} ADD CONSTRAINT ${q(`${t.name}_pkey`)} PRIMARY KEY (${pkCols.map(q).join(', ')})`);
    }

    for (const c of t.columns.filter((col) => col.unique)) {
      if (!actual.indexNames.includes(`${t.name}_${c.name}_key`)) {
        constraintAdds.push(`ALTER TABLE ${q(t.name)} ADD CONSTRAINT ${q(`${t.name}_${c.name}_key`)} UNIQUE (${q(c.name)})`);
      }
    }
  }

  for (const fk of t.fks) {
    const hasFk = actual !== undefined && actual.fks.some((a) => a.column === fk.column && a.refTable === fk.refTable);
    if (!hasFk) {
      constraintAdds.push(
        `ALTER TABLE ${q(t.name)} ADD CONSTRAINT ${q(`${t.name}_${fk.column}_fkey`)} ` +
          `FOREIGN KEY (${q(fk.column)}) REFERENCES ${q(fk.refTable)}(${q(fk.refColumn)}) ON DELETE ${onDeleteClause(fk.onDelete)}`,
      );
    }
  }

  for (const idx of t.indexes) {
    if (actual !== undefined && actual.indexNames.includes(idx.name)) continue;
    const using = idx.method === 'gin' ? ' USING gin' : '';
    indexAdds.push(
      `CREATE INDEX ${q(idx.name)} ON ${q(t.name)}${using} (${idx.columns.map(q).join(', ')})`,
    );
  }

  return [...statements, ...constraintAdds.map((s) => `${s};`), ...indexAdds.map((s) => `${s};`)];
}

/** diff all expected tables vs actual, ordered safely (creates → alters → constraints → indexes) */
export function diffAll(
  expected: ExpectedTable[],
  actual: ReadonlyMap<string, ActualTable>,
  locale?: Locale,
): string[] {
  const statements: string[] = [];
  const creates: string[] = [];
  const alters: string[] = [];
  const constraints: string[] = [];
  const indexes: string[] = [];

  for (const t of expected) {
    const a = actual.get(t.name);
    const parts = diffTable(t, a, locale);
    if (a === undefined) {
      creates.push(parts[0] ?? '');
    }
    for (const stmt of parts) {
      if (stmt.startsWith('ALTER TABLE') && !stmt.includes('ADD CONSTRAINT')) alters.push(stmt);
      else if (stmt.startsWith('ALTER TABLE') && stmt.includes('ADD CONSTRAINT')) constraints.push(stmt);
      else if (stmt.startsWith('CREATE INDEX')) indexes.push(stmt);
    }
  }

  statements.push(...creates.filter(Boolean), ...alters, ...constraints, ...indexes);
  return statements;
}

/**
 * Statements to bring one object's row-level security in line (idempotent).
 * Compares the expected policy (from the permissions matrix) against the live
 * RLS state and emits only the missing pieces. `actual` is the inspected table
 * (undefined = the table is being created in this migration, so RLS applies).
 */
export function diffRls(def: ObjectDefinition, actual: ActualTable | undefined, role: string): string[] {
  const stmts: string[] = [];
  const name = q(def.name);
  const policy = policyName(def);
  const rlsEnabled = actual?.rlsEnabled ?? false;
  const policies = actual?.rlsPolicies ?? [];
  const grants = actual?.selectGrantedTo ?? [];

  if (!rlsEnabled) {
    stmts.push(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY;`);
  }
  const expectedPolicy = buildRlsPolicy(def);
  const hasPolicy = policies.includes(policy);
  if (expectedPolicy !== undefined && !hasPolicy) {
    stmts.push(`DROP POLICY IF EXISTS ${policy} ON ${name};`);
    stmts.push(`CREATE POLICY ${policy} ON ${name} FOR SELECT USING (${expectedPolicy});`);
  } else if (expectedPolicy === undefined && hasPolicy) {
    stmts.push(`DROP POLICY IF EXISTS ${policy} ON ${name};`);
  }
  if (actual === undefined || !grants.includes(role)) {
    stmts.push(buildRlsGrantDdl(def, role));
  }
  return stmts;
}

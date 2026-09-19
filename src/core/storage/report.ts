import { FIELD_TYPES } from '../types/values.js';
import type { FieldDefinition, ObjectDefinition } from '../types/index.js';
import { buildExpectedTable } from './diff.js';
import type { ExpectedFk } from './diff.js';
import type { ActualColumn, ActualTable } from './inspect.js';
import { pgTypeMatches } from './map.js';

/**
 * Read-only schema ↔ table mapping report (`weave schema:map`): pairs every
 * declared schema field with its expected PostgreSQL column, its constraints,
 * and (when the table exists) the live column state. Pure — feed it a loaded
 * registry and an `inspectSchema(pool, { detail: true })` map; it never emits
 * DDL and never writes. `details` child auto columns and undeclared ("extra")
 * DB columns are reported, never dropped.
 */

/** per-column drift status against the live table */
export type MappingColumnStatus = 'ok' | 'missing' | 'type' | 'nullable' | 'extra';

export interface MappingColumn {
  /** schema field name (`-` for an extra DB column not declared in the schema) */
  field: string;
  /** schema field type (`relation → target.pk` for FK fields; `auto` for details columns) */
  schemaType: string;
  /** database column name */
  column: string;
  /** expected PostgreSQL type from the DDL mapping */
  pgType: string;
  notNull: boolean;
  primary: boolean;
  unique: boolean;
  /** expected DEFAULT expression, when the schema declares one */
  default?: string;
  fk?: { table: string; column: string; onDelete: string };
  index?: { name: string; method: string };
  /** engine-managed details-child column (`parent_id`/`parent_type`/`parent_idx`) */
  auto?: boolean;
  /** live column state (absent when the table or the column does not exist) */
  actual?: {
    pgType: string;
    notNull: boolean;
    default: string | null;
    typeMatch: boolean;
    nullableMatch: boolean;
  };
  status: MappingColumnStatus;
}

export interface MappingIndex {
  name: string;
  method: string;
  columns: string[];
  /** the index exists on the live table */
  present: boolean;
}

export interface MappingFk {
  column: string;
  refTable: string;
  refColumn: string;
  onDelete: string;
  /** the FK constraint exists on the live table */
  present: boolean;
}

export interface MappingRls {
  enabled: boolean;
  owner: string;
  policies: string[];
  selectGrantedTo: string[];
}

export interface MappingTable {
  object: string;
  table: string;
  label?: string;
  /** the live table exists in the database */
  exists: boolean;
  columns: MappingColumn[];
  indexes: MappingIndex[];
  fks: MappingFk[];
  /** `details` edges declared on the object (no column on the parent table) */
  details: Array<{ field: string; target: string }>;
  /** live RLS state/ownership (absent when the table does not exist) */
  rls?: MappingRls;
  warnings: string[];
  /** any column missing/mismatched, or any expected index/FK absent */
  drift: boolean;
}

export interface MappingTotals {
  objects: number;
  tablesMissing: number;
  columns: number;
  columnsOk: number;
  columnsMissing: number;
  columnsType: number;
  columnsNullable: number;
  columnsExtra: number;
  indexDrift: number;
  fkDrift: number;
}

export interface MappingReport {
  tables: MappingTable[];
  totals: MappingTotals;
}

/** readable live column type (normalizes `information_schema` spellings + numeric precision) */
function displayActualType(col: ActualColumn): string {
  const base = col.dataType.toUpperCase();
  if (base === 'CHARACTER VARYING') return 'VARCHAR';
  if (base === 'TIMESTAMP WITH TIME ZONE') return 'TIMESTAMPTZ';
  if (base === 'ARRAY' || col.udtName?.startsWith('_') === true) {
    return `${(col.udtName ?? '').replace(/^_/, '').toUpperCase()}[]`;
  }
  if (base === 'NUMERIC' || base === 'DECIMAL') {
    if (col.numericPrecision != null) {
      return col.numericScale != null ? `NUMERIC(${col.numericPrecision},${col.numericScale})` : `NUMERIC(${col.numericPrecision})`;
    }
    return 'NUMERIC';
  }
  return base;
}

/** schema-side type label (relation targets shown explicitly; enums carry their option count) */
function schemaTypeOf(field: FieldDefinition, fk: ExpectedFk | undefined): string {
  switch (field.type) {
    case FIELD_TYPES.RELATION:
    case FIELD_TYPES.PERSON:
    case FIELD_TYPES.DEPARTMENT:
      return fk === undefined ? field.type : `${field.type} → ${fk.refTable}.${fk.refColumn}`;
    case FIELD_TYPES.MULTI_RELATION:
      return `${field.type} → ${field.target}`;
    case FIELD_TYPES.ENUM:
      return `${field.type}[${field.options.length}]${field.multiple === true ? '[]' : ''}`;
    case FIELD_TYPES.IMAGE:
      return field.multiple === true ? `${field.type}[]` : field.type;
    default:
      return field.type;
  }
}

/**
 * Build the schema ↔ table mapping report for every object in `defs`, drawn
 * against the live `actual` map. Tables absent from `actual` are reported with
 * all columns `missing` (what `weave migrate` would CREATE).
 */
export function buildMappingReport(
  defs: readonly ObjectDefinition[],
  actual: ReadonlyMap<string, ActualTable>,
): MappingReport {
  const defsMap = new Map(defs.map((def) => [def.name, def]));
  const tables: MappingTable[] = [];

  for (const def of [...defs].sort((a, b) => a.name.localeCompare(b.name))) {
    const expected = buildExpectedTable(def, defsMap);
    const actualTable = actual.get(def.name);
    const warnings: string[] = [];

    const fieldByName = new Map(def.fields.map((field) => [field.name, field]));
    const indexByName = new Map(expected.indexes.map((idx) => [idx.name, idx]));
    const columns: MappingColumn[] = [];
    const covered = new Set<string>();

    for (const col of expected.columns) {
      covered.add(col.name);
      const field = fieldByName.get(col.name);
      const fk = expected.fks.find((f) => f.column === col.name);
      const index = indexByName.get(`${def.name}_${col.name}_idx`);
      const actualCol = actualTable?.columns.find((c) => c.name === col.name);

      let status: MappingColumnStatus = 'missing';
      let actualInfo: MappingColumn['actual'];
      if (actualCol !== undefined) {
        const typeMatch = pgTypeMatches(col.type, actualCol);
        const nullableMatch = col.notNull === !actualCol.isNullable;
        status = !typeMatch ? 'type' : !nullableMatch ? 'nullable' : 'ok';
        actualInfo = {
          pgType: displayActualType(actualCol),
          notNull: !actualCol.isNullable,
          default: actualCol.columnDefault,
          typeMatch,
          nullableMatch,
        };
      }

      columns.push({
        field: col.name,
        schemaType: field === undefined ? 'auto' : schemaTypeOf(field, fk),
        column: col.name,
        pgType: col.type,
        notNull: col.notNull,
        primary: col.primary,
        unique: col.unique,
        default: col.default,
        fk: fk === undefined ? undefined : { table: fk.refTable, column: fk.refColumn, onDelete: fk.onDelete },
        index: index === undefined ? undefined : { name: index.name, method: index.method },
        auto: field === undefined ? true : undefined,
        actual: actualInfo,
        status,
      });
    }

    if (actualTable !== undefined) {
      for (const actualCol of actualTable.columns) {
        if (covered.has(actualCol.name)) continue;
        columns.push({
          field: '-',
          schemaType: '-',
          column: actualCol.name,
          pgType: displayActualType(actualCol),
          notNull: !actualCol.isNullable,
          primary: actualTable.pk.includes(actualCol.name),
          unique: actualTable.uniqueColumns?.includes(actualCol.name) === true,
          actual: {
            pgType: displayActualType(actualCol),
            notNull: !actualCol.isNullable,
            default: actualCol.columnDefault,
            typeMatch: true,
            nullableMatch: true,
          },
          status: 'extra',
        });
      }
    }

    const indexes: MappingIndex[] = expected.indexes.map((idx) => ({
      name: idx.name,
      method: idx.method,
      columns: [...idx.columns],
      present: actualTable?.indexNames.includes(idx.name) === true,
    }));
    const fks: MappingFk[] = expected.fks.map((fk) => ({
      ...fk,
      present: actualTable?.fks.some((a) => a.column === fk.column && a.refTable === fk.refTable) === true,
    }));
    const details = def.fields
      .filter((field): field is Extract<FieldDefinition, { target: string }> => field.type === FIELD_TYPES.DETAILS)
      .map((field) => ({ field: field.name, target: field.target }));

    const rls: MappingRls | undefined =
      actualTable === undefined
        ? undefined
        : {
            enabled: actualTable.rlsEnabled === true,
            owner: actualTable.owner ?? '',
            policies: [...(actualTable.rlsPolicies ?? [])].sort(),
            selectGrantedTo: [...(actualTable.selectGrantedTo ?? [])].sort(),
          };

    const drift =
      actualTable === undefined ||
      columns.some((c) => c.status !== 'ok' && c.status !== 'extra') ||
      indexes.some((idx) => !idx.present) ||
      fks.some((fk) => !fk.present);

    if (actualTable === undefined) {
      warnings.push(`table "${def.name}" does not exist yet (weave migrate would CREATE it)`);
    }

    tables.push({
      object: def.name,
      table: def.name,
      label: def.label,
      exists: actualTable !== undefined,
      columns,
      indexes,
      fks,
      details,
      rls,
      warnings,
      drift,
    });
  }

  const totals: MappingTotals = {
    objects: tables.length,
    tablesMissing: 0,
    columns: 0,
    columnsOk: 0,
    columnsMissing: 0,
    columnsType: 0,
    columnsNullable: 0,
    columnsExtra: 0,
    indexDrift: 0,
    fkDrift: 0,
  };
  for (const table of tables) {
    if (!table.exists) totals.tablesMissing += 1;
    totals.indexDrift += table.indexes.filter((idx) => !idx.present).length;
    totals.fkDrift += table.fks.filter((fk) => !fk.present).length;
    for (const col of table.columns) {
      totals.columns += 1;
      if (col.status === 'ok') totals.columnsOk += 1;
      else if (col.status === 'missing') totals.columnsMissing += 1;
      else if (col.status === 'type') totals.columnsType += 1;
      else if (col.status === 'nullable') totals.columnsNullable += 1;
      else totals.columnsExtra += 1;
    }
  }

  return { tables, totals };
}

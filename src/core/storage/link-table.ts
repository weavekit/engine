import {
  DEFAULT_FIELD_TYPE_REGISTRY,
  FIELD_TYPES,
  primaryFieldsOf,
  type FieldTypeRegistry,
  type ObjectDefinition,
} from '../types/index.js';
import { pgType } from './map.js';
import type { ExpectedColumn, ExpectedFk, ExpectedIndex, ExpectedTable } from './diff.js';

/**
 * Engine-owned many-to-many **link tables** backing `multiRelation` fields.
 *
 * A `multiRelation` field stores no column on its owner table; instead one link
 * table holds the (owner, target) pairs and an order index. Columns mirror the
 * two primary keys (so both sides get a **real composite foreign key** with
 * `ON DELETE CASCADE`), which requires the multi-column FK support in
 * `ExpectedFk`/`ActualFk`.
 *
 * Link tables are engine plumbing (like `weavekit_record__<object>`): created
 * only by `weave migrate`, never declared in `objects/`, and not visible to the
 * restricted-SQL/script surface. They live in the connection's `current_schema()`.
 */

/** reserved name prefix — `weavekit_m2m__<object>__<field>` */
export const LINK_TABLE_PREFIX = 'weavekit_m2m__';

/** order column (preserves the array order of the declared value) */
export const LINK_IDX_COLUMN = 'idx';

/** link-table name for one `(object, multiRelation field)` pair */
export function linkTableName(object: string, field: string): string {
  return `${LINK_TABLE_PREFIX}${object}__${field}`;
}

/** true when a live table name is an engine multiRelation link table */
export function isLinkTable(name: string): boolean {
  return name.startsWith(LINK_TABLE_PREFIX);
}

/** owner-side FK column name for one owner primary-key field */
export function linkOwnerColumn(pk: string): string {
  return `owner_${pk}`;
}

/** target-side FK column name for one target primary-key field */
export function linkTargetColumn(pk: string): string {
  return `target_${pk}`;
}

/** a `multiRelation` field resolved against its target object definition */
export interface ResolvedMultiRelation {
  field: Extract<ObjectDefinition['fields'][number], { type: typeof FIELD_TYPES.MULTI_RELATION }>;
  target: ObjectDefinition;
}

/**
 * Every `multiRelation` field of `owner`, paired with its resolved target.
 * Fields whose target is absent from `defs` are skipped (the loader's graph
 * validation already rejects dangling targets).
 */
export function multiRelationsOf(
  owner: ObjectDefinition,
  defs: ReadonlyMap<string, ObjectDefinition>,
): ResolvedMultiRelation[] {
  const out: ResolvedMultiRelation[] = [];
  for (const field of owner.fields) {
    if (field.type !== FIELD_TYPES.MULTI_RELATION) continue;
    const target = defs.get(field.target);
    if (target !== undefined) out.push({ field, target });
  }
  return out;
}

/** the expected (DDL) shape of one multiRelation link table */
export function buildLinkTable(
  owner: ObjectDefinition,
  field: Extract<ObjectDefinition['fields'][number], { type: typeof FIELD_TYPES.MULTI_RELATION }>,
  target: ObjectDefinition,
  registry: FieldTypeRegistry = DEFAULT_FIELD_TYPE_REGISTRY,
): ExpectedTable {
  const name = linkTableName(owner.name, field.name);
  const ownerPks = primaryFieldsOf(owner);
  const targetPks = primaryFieldsOf(target);

  const ownerCols = ownerPks.map((pk) => ({ pk, column: linkOwnerColumn(pk.name) }));
  const targetCols = targetPks.map((pk) => ({ pk, column: linkTargetColumn(pk.name) }));

  const columns: ExpectedColumn[] = [
    ...ownerCols.map(({ pk, column }) => ({
      name: column,
      type: pgType(pk, undefined, registry),
      notNull: true,
      primary: true,
      unique: false,
    })),
    ...targetCols.map(({ pk, column }) => ({
      name: column,
      type: pgType(pk, undefined, registry),
      notNull: true,
      primary: true,
      unique: false,
    })),
    { name: LINK_IDX_COLUMN, type: 'INTEGER', notNull: true, primary: false, unique: false },
  ];

  const fks: ExpectedFk[] = [];
  if (ownerPks.length > 0) {
    fks.push({
      columns: ownerCols.map((c) => c.column),
      refTable: owner.name,
      refColumns: ownerPks.map((p) => p.name),
      onDelete: 'cascade',
    });
  }
  if (targetPks.length > 0) {
    fks.push({
      columns: targetCols.map((c) => c.column),
      refTable: target.name,
      refColumns: targetPks.map((p) => p.name),
      onDelete: 'cascade',
    });
  }

  // the composite PK (owner…, target…) already indexes the owner side; add a
  // target-side index so the cascade/reverse lookup is not a seq scan
  const indexes: ExpectedIndex[] = [
    { name: `${name}_target_idx`, method: 'btree', columns: targetCols.map((c) => c.column) },
  ];

  return { name, columns, fks, indexes, uniques: [] };
}

/** every link table implied by the given object definitions, in stable order */
export function buildLinkTables(
  defs: ReadonlyMap<string, ObjectDefinition>,
  registry: FieldTypeRegistry = DEFAULT_FIELD_TYPE_REGISTRY,
): ExpectedTable[] {
  const tables: ExpectedTable[] = [];
  for (const owner of defs.values()) {
    for (const { field, target } of multiRelationsOf(owner, defs)) {
      tables.push(buildLinkTable(owner, field, target, registry));
    }
  }
  return tables;
}

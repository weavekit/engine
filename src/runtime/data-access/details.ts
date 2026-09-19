import type { Locale, ObjectDefinition, ObjectRegistry } from '../../core/index.js';
import { SchemaError } from '../../core/index.js';
import { DETAILS_COLUMNS, FIELD_TYPES } from '../../core/index.js';
import type { Queryable } from './types.js';
import { validateRecord } from './validate.js';
import { WRITE_MODES } from './values.js';

const q = (id: string) => `"${id}"`;

function detailsFields(object: ObjectDefinition): ObjectDefinition['fields'][number][] {
  return object.fields.filter((f) => f.type === FIELD_TYPES.DETAILS);
}

function childDef(registry: ObjectRegistry, target: string): ObjectDefinition | undefined {
  return registry.get(target);
}

/**
 * Insert nested details rows on parent create. Auto-fills parent_id/parent_type/
 * parent_idx; each child row is validated against the child object definition.
 */
export async function insertDetails(
  db: Queryable,
  parent: ObjectDefinition,
  parentPk: unknown,
  data: Record<string, unknown>,
  registry: ObjectRegistry,
  locale?: Locale,
): Promise<void> {
  for (const df of detailsFields(parent)) {
    const rows = data[df.name];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) {
      throw new SchemaError('data.field.type', { object: parent.name, field: df.name, type: 'details array' }, locale);
    }
    const child = childDef(registry, (df as { target: string }).target);
    if (child === undefined) continue;
    const table = child.name;
    const modelCols = child.fields.filter((f) => f.type !== FIELD_TYPES.DETAILS).map((f) => f.name);
    const cols = [...modelCols, DETAILS_COLUMNS.PARENT_ID, DETAILS_COLUMNS.PARENT_TYPE, DETAILS_COLUMNS.PARENT_IDX];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        throw new SchemaError('data.field.type', { object: parent.name, field: df.name, type: 'details array' }, locale);
      }
      const record = row as Record<string, unknown>;
      record[DETAILS_COLUMNS.PARENT_ID] = parentPk;
      record[DETAILS_COLUMNS.PARENT_TYPE] = parent.name;
      record[DETAILS_COLUMNS.PARENT_IDX] = i + 1;
      await validateRecord(child, record, WRITE_MODES.CREATE, { pool: db, registry, locale });
      const values = [...modelCols.map((c) => record[c] ?? null), parentPk, parent.name, i + 1];
      const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(', ');
      await db.query(`INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) VALUES (${placeholders})`, values);
    }
  }
}

/** delete all child rows of a parent (cascade on parent delete) */
export async function deleteDetailsChildren(
  db: Queryable,
  parent: ObjectDefinition,
  parentPk: unknown,
  registry: ObjectRegistry,
): Promise<void> {
  for (const df of detailsFields(parent)) {
    const child = childDef(registry, (df as { target: string }).target);
    if (child === undefined) continue;
    const table = child.name;
    await db.query(
      `DELETE FROM ${q(table)} WHERE ${q(DETAILS_COLUMNS.PARENT_ID)} = $1 AND ${q(DETAILS_COLUMNS.PARENT_TYPE)} = $2`,
      [parentPk, parent.name],
    );
  }
}

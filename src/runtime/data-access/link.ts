import type { Locale, ObjectDefinition, ObjectRegistry } from '../../core/index.js';
import {
  FIELD_TYPES,
  LINK_IDX_COLUMN,
  SchemaError,
  decodeRecordKey,
  linkOwnerColumn,
  linkTableName,
  linkTargetColumn,
  primaryFieldsOf,
} from '../../core/index.js';
import type { Queryable } from './types.js';

const q = (id: string) => `"${id}"`;

/** a `multiRelation` field of the owner object */
type MultiRelField = Extract<ObjectDefinition['fields'][number], { type: typeof FIELD_TYPES.MULTI_RELATION }>;

function multiFields(owner: ObjectDefinition): MultiRelField[] {
  return owner.fields.filter((f): f is MultiRelField => f.type === FIELD_TYPES.MULTI_RELATION);
}

/** decode an external target id into the raw PK values for the link columns */
function targetPkValues(target: ObjectDefinition, id: unknown, locale?: Locale): unknown[] {
  const pks = primaryFieldsOf(target);
  if (pks.length === 1) return [id];
  if (typeof id !== 'string') {
    throw new SchemaError('data.field.type', { field: 'multiRelation', type: 'record key' }, locale);
  }
  const tuple = decodeRecordKey(id);
  if (tuple.length !== pks.length) {
    throw new SchemaError('data.field.multiRelationMissing', { field: 'multiRelation' }, locale);
  }
  return tuple;
}

/** insert the link rows for one multiRelation field (dedup by target PK; order via idx) */
async function writeLinks(
  db: Queryable,
  owner: ObjectDefinition,
  field: MultiRelField,
  target: ObjectDefinition,
  ownerPkValues: readonly unknown[],
  ids: readonly unknown[],
  locale?: Locale,
): Promise<void> {
  const ownerCols = primaryFieldsOf(owner).map((p) => linkOwnerColumn(p.name));
  const targetCols = primaryFieldsOf(target).map((p) => linkTargetColumn(p.name));
  const cols = [...ownerCols, ...targetCols, LINK_IDX_COLUMN];
  const seen = new Set<string>();
  const rows: unknown[][] = [];
  for (const id of ids) {
    const tvals = targetPkValues(target, id, locale);
    const key = tvals.map(String).join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([...ownerPkValues, ...tvals, rows.length]);
  }
  if (rows.length === 0) return;
  const placeholders = rows
    .map((_, r) => `(${cols.map((_, c) => `$${r * cols.length + c + 1}`).join(', ')})`)
    .join(', ');
  await db.query(
    `INSERT INTO ${q(linkTableName(owner.name, field.name))} (${cols.map(q).join(', ')}) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
    rows.flat(),
  );
}

/** delete every link row of one owner row for one multiRelation field */
async function deleteFieldLinks(
  db: Queryable,
  owner: ObjectDefinition,
  field: MultiRelField,
  ownerPkValues: readonly unknown[],
): Promise<void> {
  const ownerCols = primaryFieldsOf(owner).map((p) => linkOwnerColumn(p.name));
  const where = ownerCols.map((c, i) => `${q(c)} = $${i + 1}`).join(' AND ');
  await db.query(`DELETE FROM ${q(linkTableName(owner.name, field.name))} WHERE ${where}`, [...ownerPkValues]);
}

function assertArray(value: unknown, owner: string, field: string, locale?: Locale): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new SchemaError('data.field.type', { object: owner, field, type: 'array' }, locale);
  }
}

/** insert link rows on create (a multiRelation value present in the payload) */
export async function insertLinks(
  db: Queryable,
  owner: ObjectDefinition,
  ownerPkValues: readonly unknown[],
  payload: Record<string, unknown>,
  registry: ObjectRegistry,
  locale?: Locale,
): Promise<void> {
  for (const field of multiFields(owner)) {
    const value = payload[field.name];
    if (value === undefined) continue;
    assertArray(value, owner.name, field.name, locale);
    const target = registry.get(field.target);
    if (target === undefined) continue;
    await writeLinks(db, owner, field, target, ownerPkValues, value, locale);
  }
}

/** replace link rows on update (only fields present in the payload) */
export async function replaceLinks(
  db: Queryable,
  owner: ObjectDefinition,
  ownerPkValues: readonly unknown[],
  payload: Record<string, unknown>,
  registry: ObjectRegistry,
  locale?: Locale,
): Promise<void> {
  for (const field of multiFields(owner)) {
    const value = payload[field.name];
    if (value === undefined) continue;
    assertArray(value, owner.name, field.name, locale);
    const target = registry.get(field.target);
    if (target === undefined) continue;
    await deleteFieldLinks(db, owner, field, ownerPkValues);
    await writeLinks(db, owner, field, target, ownerPkValues, value, locale);
  }
}

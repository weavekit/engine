import type { ObjectDefinition, ObjectRegistry } from '../../core/index.js';
import { DETAILS_COLUMNS, FIELD_TYPES, primaryKeyOf } from '../../core/index.js';
import { evaluate, extractRefs, parseFormula } from '../../core/index.js';
import type { FormulaExpr } from '../../core/index.js';
import type { Queryable } from './types.js';

const q = (id: string) => `"${id}"`;

/** resolve a cross-object field reference (relation target field), or null */
async function resolveRefValue(
  object: ObjectDefinition,
  parent: string,
  name: string,
  record: Record<string, unknown>,
  db: Queryable,
  registry: ObjectRegistry,
): Promise<unknown> {
  const parentField = object.fields.find((f) => f.name === parent);
  if (parentField === undefined || parentField.type !== FIELD_TYPES.RELATION) return null;
  const fk = record[parent];
  if (fk === null || fk === undefined) return null;
  const target = registry.get(parentField.target);
  if (target === undefined) return null;
  const table = target.name;
  const pk = primaryKeyOf(target);
  if (pk === undefined) return null;
  const res = await db.query(
    `SELECT ${q(name)} FROM ${q(table)} WHERE ${q(pk)} = $1`,
    [fk],
  );
  const row = res.rows[0];
  return row === undefined ? null : (row[name as keyof typeof row] ?? null);
}

/** resolve details aggregation values for a child field (name = null for COUNT) */
async function resolveAggregateValue(
  object: ObjectDefinition,
  parent: string,
  name: string | null,
  record: Record<string, unknown>,
  db: Queryable,
  registry: ObjectRegistry,
): Promise<unknown[]> {
  const parentField = object.fields.find((f) => f.name === parent);
  if (parentField === undefined || parentField.type !== FIELD_TYPES.DETAILS) return [];
  const child = registry.get(parentField.target);
  if (child === undefined) return [];
  const pk = primaryKeyOf(object);
  if (pk === undefined) return [];
  const pkVal = record[pk];
  if (pkVal === null || pkVal === undefined) return [];
  const table = child.name;
  const res = await db.query(
    `SELECT ${name === null ? '1' : q(name)} AS v FROM ${q(table)}
     WHERE ${q(DETAILS_COLUMNS.PARENT_TYPE)} = $1 AND ${q(DETAILS_COLUMNS.PARENT_ID)} = $2`,
    [object.name, pkVal],
  );
  return res.rows.map((r) => (r as { v: unknown }).v);
}

/** pre-fetch all cross refs + aggregates, then evaluate synchronously */
async function evalWithResolvers(
  ast: FormulaExpr,
  object: ObjectDefinition,
  record: Record<string, unknown>,
  db: Queryable,
  registry: ObjectRegistry,
  now: Date,
): Promise<unknown> {
  const { fields: refs, aggregates } = extractRefs(ast);

  const refValues = new Map<string, unknown>();
  for (const ref of refs) {
    if (ref.parent === null) continue;
    const key = `${ref.parent}.${ref.name}`;
    if (refValues.has(key)) continue;
    refValues.set(key, await resolveRefValue(object, ref.parent, ref.name, record, db, registry));
  }

  const aggValues = new Map<string, unknown[]>();
  for (const agg of aggregates) {
    const key = `${agg.parent}.${agg.name ?? ''}`;
    if (aggValues.has(key)) continue;
    aggValues.set(key, await resolveAggregateValue(object, agg.parent, agg.name, record, db, registry));
  }

  return evaluate(ast, {
    record,
    resolveRef: (parent, name) => refValues.get(`${parent}.${name}`) ?? null,
    resolveAggregate: (parent, name) => aggValues.get(`${parent}.${name ?? ''}`) ?? [],
    now: () => now,
  });
}

function coerce(value: unknown, type: string): unknown {
  if (value === null) return null;
  switch (type) {
    case FIELD_TYPES.STRING:
    case FIELD_TYPES.TEXT:
      return String(value);
    case FIELD_TYPES.INTEGER:
      return typeof value === 'number' ? Math.round(value) : null;
    case FIELD_TYPES.NUMBER:
    case FIELD_TYPES.CURRENCY:
      return typeof value === 'number' ? value : null;
    case FIELD_TYPES.BOOLEAN:
      return Boolean(value);
    default:
      return value;
  }
}

/**
 * Evaluate all formula fields of an object against a record (mutating it),
 * resolving cross-object references and details aggregations via PG.
 */
export async function computeFormulas(
  object: ObjectDefinition,
  record: Record<string, unknown>,
  db: Queryable,
  registry: ObjectRegistry,
  now: Date,
): Promise<void> {
  const formulaFields = object.fields.filter((f) => (f as { formula?: string }).formula !== undefined);
  if (formulaFields.length === 0) return;
  for (const field of formulaFields) {
    const formula = (field as { formula: string }).formula;
    const ast = parseFormula(formula);
    const value = await evalWithResolvers(ast, object, record, db, registry, now);
    record[field.name] = coerce(value, field.type);
  }
}

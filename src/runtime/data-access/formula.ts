import type { IdentitySubject, Locale, ObjectDefinition, ObjectRegistry } from '../../core/index.js';
import {
  DETAILS_COLUMNS,
  FIELD_TYPES,
  primaryFieldsOf,
  decodeRecordKey,
  encodeRecordKey,
  canonicalizePrimaryValue,
  resolvePermissionFor,
  buildRowScopeFor,
} from '../../core/index.js';
import { evaluate, extractRefs, parseFormula } from '../../core/index.js';
import type { FormulaExpr } from '../../core/index.js';
import type { Queryable } from './types.js';
import { scopeSuffix } from './builder.js';

const q = (id: string) => `"${id}"`;

/** authorization input for cross-object resolution (subject absent = unrestricted/internal) */
export interface FormulaAuth {
  subject?: IdentitySubject;
  roles: readonly string[];
  locale?: Locale;
}

/** relation-like field types that carry a cross-object `target` (details handled separately) */
const REF_TYPES = new Set<string>([FIELD_TYPES.RELATION, FIELD_TYPES.USER, FIELD_TYPES.DEPARTMENT]);

/** resolve a cross-object field reference (relation target field), or null */
async function resolveRefValue(
  object: ObjectDefinition,
  parent: string,
  name: string,
  record: Record<string, unknown>,
  db: Queryable,
  registry: ObjectRegistry,
  auth?: FormulaAuth,
): Promise<unknown> {
  const parentField = object.fields.find((f) => f.name === parent);
  if (parentField === undefined || !REF_TYPES.has(parentField.type)) {
    return null;
  }
  const fk = record[parent];
  if (fk === null || fk === undefined) return null;
  const target = registry.get((parentField as { target: string }).target);
  if (target === undefined) return null;
  // RBAC: the subject must be able to read the target object (row + column scope);
  // denied → null (no existence leak). No subject = unrestricted (internal use).
  let scope: { sql: string; params: unknown[] } | undefined;
  if (auth?.subject !== undefined) {
    const p = resolvePermissionFor(registry, target, auth.roles);
    if (p?.read === undefined) return null;
    if (p.exclude.includes(name)) return null;
    scope = buildRowScopeFor(registry, target, p.read, auth.subject, auth.roles, auth.locale);
  }
  const table = target.name;
  const pks = primaryFieldsOf(target);
  if (pks.length === 0) return null;
  let sql: string;
  let params: unknown[];
  if (pks.length === 1) {
    sql = `SELECT ${q(name)} FROM ${q(table)} WHERE ${q(pks[0]!.name)} = $1`;
    params = [fk];
  } else {
    let values: string[];
    try {
      values = decodeRecordKey(String(fk));
    } catch {
      return null;
    }
    if (values.length !== pks.length) return null;
    const where = pks.map((p, i) => `${q(p.name)} = $${i + 1}`).join(' AND ');
    sql = `SELECT ${q(name)} FROM ${q(table)} WHERE ${where}`;
    params = values;
  }
  if (scope !== undefined) {
    const scoped = scopeSuffix(scope, params.length);
    sql = `${sql} AND (${scoped.sql})`;
    params = [...params, ...scoped.params];
  }
  if (pks.length !== 1) sql = `${sql} LIMIT 1`;
  const res = await db.query(sql, params);
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
  recordKey?: string,
  auth?: FormulaAuth,
): Promise<unknown[]> {
  const parentField = object.fields.find((f) => f.name === parent);
  if (parentField === undefined || parentField.type !== FIELD_TYPES.DETAILS) return [];
  const child = registry.get(parentField.target);
  if (child === undefined) return [];
  const pks = primaryFieldsOf(object);
  if (pks.length === 0) return [];
  // details children are keyed by the parent's record_key (the external id); use
  // the lossless SQL-computed key when the caller has it, else derive it
  const pkVal = recordKey ?? encodeRecordKey(pks.map((f) => canonicalizePrimaryValue(record[f.name])));
  if (pkVal === '') return [];
  // RBAC: aggregating a child field requires read on the (parent-inherited) child
  let scope: { sql: string; params: unknown[] } | undefined;
  if (auth?.subject !== undefined) {
    const p = resolvePermissionFor(registry, child, auth.roles);
    if (p?.read === undefined) return [];
    if (name !== null && p.exclude.includes(name)) return [];
    scope = buildRowScopeFor(registry, child, p.read, auth.subject, auth.roles, auth.locale);
  }
  const table = child.name;
  let sql = `SELECT ${name === null ? '1' : q(name)} AS v FROM ${q(table)}
     WHERE ${q(DETAILS_COLUMNS.PARENT_TYPE)} = $1 AND ${q(DETAILS_COLUMNS.PARENT_ID)} = $2`;
  const params: unknown[] = [object.name, pkVal];
  if (scope !== undefined) {
    const scoped = scopeSuffix(scope, params.length);
    sql = `${sql} AND (${scoped.sql})`;
    params.push(...scoped.params);
  }
  const res = await db.query(sql, params);
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
  recordKey?: string,
  auth?: FormulaAuth,
): Promise<unknown> {
  const { fields: refs, aggregates } = extractRefs(ast);

  const refValues = new Map<string, unknown>();
  for (const ref of refs) {
    if (ref.parent === null) continue;
    const key = `${ref.parent}.${ref.name}`;
    if (refValues.has(key)) continue;
    refValues.set(key, await resolveRefValue(object, ref.parent, ref.name, record, db, registry, auth));
  }

  const aggValues = new Map<string, unknown[]>();
  for (const agg of aggregates) {
    const key = `${agg.parent}.${agg.name ?? ''}`;
    if (aggValues.has(key)) continue;
    aggValues.set(key, await resolveAggregateValue(object, agg.parent, agg.name, record, db, registry, recordKey, auth));
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
 * resolving cross-object references and details aggregations via PG. When
 * `auth.subject` is set, every cross-object read is scoped by the subject's
 * RBAC (a denied reference resolves to null rather than leaking data).
 */
export async function computeFormulas(
  object: ObjectDefinition,
  record: Record<string, unknown>,
  db: Queryable,
  registry: ObjectRegistry,
  now: Date,
  recordKey?: string,
  auth?: FormulaAuth,
): Promise<void> {
  const formulaFields = object.fields.filter((f) => (f as { formula?: string }).formula !== undefined);
  if (formulaFields.length === 0) return;
  for (const field of formulaFields) {
    const formula = (field as { formula: string }).formula;
    const ast = parseFormula(formula);
    const value = await evalWithResolvers(ast, object, record, db, registry, now, recordKey, auth);
    record[field.name] = coerce(value, field.type);
  }
}

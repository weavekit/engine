import type { PoolClient } from 'pg';
import type { ObjectDefinition, ObjectRegistry } from '../../core/index.js';
import {
  SchemaError,
  primaryFieldsOf,
  encodeRecordKey,
  decodeRecordKey,
  canonicalizePrimaryValue,
  principalActorId,
  DETAILS_COLUMNS,
  FIELD_TYPES,
  isSideTableVirtualField,
  recordKeySql,
  type Locale,
  type ScriptUser,
  type ToolDataAccess,
} from '../../core/index.js';
import type { AuditEvent, AuditSink } from '../../core/audit/index.js';
import { AUDIT_ACTOR_TYPES } from '../../core/audit/index.js';
import type { BuildContext } from './builder.js';
import type { FormulaAuth } from './formula.js';
import { subjectOf, scopeOf, type DataAccessContext, type FindOptions, type ObjectDataAccess } from './types.js';

/**
 * Pure helpers for the object data-access layer — extracted from `query.ts` so
 * the `DefaultObjectDataAccess` class stays focused on orchestration. None of
 * these touch instance state; they operate on their arguments only.
 */

export const q = (id: string) => `"${id}"`;

/** cross-object formula authorization derived from the request context */
export function formulaAuth(ctx: DataAccessContext): FormulaAuth {
  const subject = subjectOf(ctx);
  return { subject, roles: subject?.roles ?? [], locale: ctx.locale };
}

/** pg QueryResult shape the drift wrapper needs */
export interface QueryResultLike {
  rows: unknown[];
  rowCount?: number | null;
}

/** PG error 42703 = undefined_column: a query referenced a column that doesn't exist */
function isUndefinedColumn(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '42703';
}

/** parse `column "X" of relation "Y" does not exist` → the column/field name */
function undefinedColumnOf(error: unknown): string | undefined {
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return undefined;
  const m = /column "([^"]+)" of relation/.exec(message);
  return m?.[1];
}

/** PG error 23505 = unique_violation: a unique constraint (column or object constraint) was hit */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';
}

/** readable field list behind a unique violation (from the detail `Key (a, b)=(...)`) */
function uniqueFieldsOf(error: unknown): string {
  const detail = (error as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string') {
    const m = /Key \(([^)]+)\)/.exec(detail);
    if (m?.[1] !== undefined) return m[1];
  }
  const constraint = (error as { constraint?: unknown } | null)?.constraint;
  return typeof constraint === 'string' ? constraint : '?';
}

/**
 * Run a SQL statement against an object's table, mapping PG `undefined_column`
 * (42703) — a schema/DB drift (schema declares a field the table lacks) — to an
 * actionable error instead of a raw 500.
 */
export async function runTableQuery(
  q: { query(sql: string, params: unknown[]): Promise<QueryResultLike> },
  objectName: string,
  sql: string,
  params: unknown[],
  locale?: Locale,
): Promise<QueryResultLike> {
  try {
    return await q.query(sql, params);
  } catch (error) {
    if (isUndefinedColumn(error)) {
      const field = undefinedColumnOf(error);
      throw new SchemaError('data.schemaDrift', { object: objectName, field: field ?? '' }, locale);
    }
    if (isUniqueViolation(error)) {
      throw new SchemaError('data.unique', { object: objectName, fields: uniqueFieldsOf(error) }, locale);
    }
    throw error;
  }
}

/** emit a write-audit event (transaction-aware: in-tx when a tx-capable sink is active) */
export async function auditWrite(
  sink: AuditSink | undefined,
  ctx: DataAccessContext,
  action: string,
  objectName: string,
  objectId: string | undefined,
  changes: unknown,
  error?: unknown,
  before?: unknown,
  after?: unknown,
  client?: PoolClient,
): Promise<void> {
  if (sink === undefined) return;
  const principal = ctx.principal;
  const scopeValue = scopeOf(ctx);
  const event: AuditEvent = {
    actorType: principal.kind === 'user' ? AUDIT_ACTOR_TYPES.USER : AUDIT_ACTOR_TYPES.SYSTEM,
    actorId: principalActorId(principal),
    action,
    objectName,
    objectId,
    changes,
    isError: error !== undefined,
    errorCode: error instanceof SchemaError ? error.code : undefined,
    ...(principal.kind === 'system' ? { meta: { capability: principal.capability } } : {}),
    ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
    ...(ctx.traceId === undefined ? {} : { traceId: ctx.traceId }),
    ...(scopeValue === undefined ? {} : { scopeId: scopeValue }),
    timestamp: new Date(),
  };
  if (before !== undefined) event.before = before;
  if (after !== undefined) event.after = after;
  // transactional/durable sinks write inside the business transaction; a throw
  // here rolls the business write back (deliberate)
  if (client !== undefined && sink.recordInTx !== undefined) {
    await sink.recordInTx(event, client);
    return;
  }
  void sink.record(event);
}

/** rebuild `this.user` for hooks from the authenticated subject */
export function scriptUserOf(ctx: DataAccessContext): ScriptUser {
  const subject = subjectOf(ctx);
  return {
    id: subject?.id ?? 'system',
    roles: subject?.roles ?? [],
    departmentId: subject?.departmentId,
    ...(subject?.scopeId === undefined ? {} : { scopeId: subject.scopeId }),
  };
}

/** details child auto columns (`parent_id`/`parent_type`/`parent_idx`) */
export const PARENT_COLUMNS = new Set<string>([
  DETAILS_COLUMNS.PARENT_ID,
  DETAILS_COLUMNS.PARENT_TYPE,
  DETAILS_COLUMNS.PARENT_IDX,
]);

export function isDetailsChild(registry: ObjectRegistry, name: string): boolean {
  return registry
    .list()
    .some((o) => o.fields.some((f) => f.type === FIELD_TYPES.DETAILS && f.target === name));
}

export function requireDef(ctx: DataAccessContext, objectName: string): ObjectDefinition {
  const def = ctx.registry.get(objectName);
  if (def === undefined) throw new SchemaError('data.objectUnknown', { object: objectName }, ctx.locale);
  return def;
}

export function bctx(ctx: DataAccessContext, objectName: string): BuildContext {
  const subject = subjectOf(ctx);
  return {
    object: objectName,
    locale: ctx.locale,
    allowParentCols: isDetailsChild(ctx.registry, objectName),
    lookup: ctx.registry,
    ...(subject === undefined ? {} : { subject }),
  };
}

/** hidden select column carrying the SQL-computed record_key for a fetched row */
export const META_KEY_COL = '__weave_record_key';

/** select expression for the SQL-computed record_key (lossless for temporal keys) */
export function recordKeySelect(def: ObjectDefinition): string {
  return `${recordKeySql(def, (name) => q(name))} AS ${q(META_KEY_COL)}`;
}

/** the record_key of a row, from its declared primary fields (declaration order) */
export function recordKeyOfRow(def: ObjectDefinition, record: Record<string, unknown>): string {
  return encodeRecordKey(primaryFieldsOf(def).map((f) => canonicalizePrimaryValue(record[f.name])));
}

/** declared primary field names, in declaration order */
export function primaryNames(def: ObjectDefinition): string[] {
  return primaryFieldsOf(def).map((f) => f.name);
}

/** decode an external id (the record_key, for single and composite keys alike) into primary values */
export function pkValuesOf(def: ObjectDefinition, id: string, ctx: DataAccessContext): string[] {
  const names = primaryNames(def);
  let values: string[];
  try {
    values = decodeRecordKey(id);
  } catch {
    throw new SchemaError('recordKey.invalid', { key: id }, ctx.locale);
  }
  if (values.length !== names.length) {
    throw new SchemaError('recordKey.invalid', { key: id }, ctx.locale);
  }
  return values;
}

/** reject a malformed external id up front (keyed objects only; key-less objects 404 later) */
export function validateId(def: ObjectDefinition, id: string, ctx: DataAccessContext): void {
  if (primaryNames(def).length > 0) pkValuesOf(def, id, ctx);
}

/** primary-key filter object for `find` (declared names zipped with values) */
export function pkFilter(def: ObjectDefinition, values: readonly string[]): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  primaryNames(def).forEach((name, i) => {
    filter[name] = values[i];
  });
  return filter;
}

/** `"a" = $1 AND "b" = $2` predicate for the primary names, starting at `startIndex` */
export function pkWhereSql(def: ObjectDefinition, startIndex: number): string {
  return primaryNames(def)
    .map((name, i) => `${q(name)} = $${startIndex + i}`)
    .join(' AND ');
}

/** the external id of a record: always its record_key (single and composite keys alike) */
export function externalIdOf(def: ObjectDefinition, record: Record<string, unknown>): string {
  return recordKeyOfRow(def, record);
}

/** true when the query references a side-table virtual field (`weave_*` minus the derived `weave_id`) */
export function needsSideTable(opts: FindOptions): boolean {
  if ((opts.fields ?? []).some((f) => isSideTableVirtualField(f))) return true;
  if ((opts.sort ?? []).some((s) => isSideTableVirtualField(s.field))) return true;
  const filter = opts.filter;
  if (filter !== undefined) {
    for (const [key, value] of Object.entries(filter)) {
      if (key === '$or') {
        if (
          Array.isArray(value) &&
          value.some(
            (group) =>
              group !== null &&
              typeof group === 'object' &&
              Object.keys(group).some((k) => isSideTableVirtualField(k)),
          )
        ) {
          return true;
        }
      } else if (isSideTableVirtualField(key)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Narrow `ToolDataAccess` over this data-access for guardrail policies: a policy
 * calls `ctx.dataAccess.find(obj, opts, { subject? })` with no pool/registry, so
 * those are injected from the execution context (mirrors the tool executor's
 * wrapper; `...c` lets a policy override the subject per call).
 */
export function toolDataAccessOver(inner: ObjectDataAccess, base: DataAccessContext): ToolDataAccess {
  return {
    find: (n, o, c) => inner.find(n, o as unknown as FindOptions, { ...base, ...c }),
    findOne: (n, id, c) => inner.findOne(n, id, { ...base, ...c }),
    create: (n, d, c) => inner.create(n, d, { ...base, ...c }),
    update: (n, id, changes, c) => inner.update(n, id, changes, { ...base, ...c }),
    delete: (n, id, c) => inner.delete(n, id, { ...base, ...c }),
  } as ToolDataAccess;
}

/**
 * Serialize a value for binding to a DB column. pg (node-postgres) auto-stringifies
 * JSON *objects* but serializes JSON *arrays* as a PG array literal (`{"a"}`) which
 * is invalid as `json` — so we explicitly `JSON.stringify` non-string json values
 * (arrays/objects/numbers/booleans) to valid JSON text. `null` stays SQL NULL.
 */
export function dbJsonValue(field: { type?: string } | undefined, value: unknown): unknown {
  if (
    field !== undefined &&
    (field.type === FIELD_TYPES.JSON || field.type === FIELD_TYPES.JSONB) &&
    value !== null &&
    typeof value !== 'string'
  ) {
    return JSON.stringify(value);
  }
  return value;
}

import type { Locale, ObjectDefinition } from "../../core/index.js";
import { SchemaError } from "../../core/index.js";
import { DETAILS_COLUMNS } from "../../core/index.js";
import { FIELD_TYPES } from "../../core/index.js";
import type { Filter, FindOptions, FilterValue, Sort } from "./types.js";
import type { FilterOp } from "./values.js";
import { FILTER_OPS, PAGINATION } from "./values.js";

const q = (id: string) => `"${id}"`;

const PARENT_COLUMNS = new Set<string>(Object.values(DETAILS_COLUMNS));

/** renumber a parameterized fragment (`$1..$k`) to start after `offset` already-used params */
export function scopeSuffix(
  scope: { sql: string; params: unknown[] },
  offset: number,
): { sql: string; params: unknown[] } {
  if (offset === 0) return scope;
  return {
    sql: scope.sql.replace(/\$\d+/g, (m) => `$${Number(m.slice(1)) + offset}`),
    params: scope.params,
  };
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

export interface BuildContext {
  object: string;
  locale?: Locale;
  /** allow the engine-managed parent_id/parent_type/parent_idx columns (details child objects) */
  allowParentCols?: boolean;
}

export interface RowScope {
  sql: string;
  params: unknown[];
}

function fail(ctx: BuildContext, field: string): never {
  throw new SchemaError(
    "data.field.unknown",
    { object: ctx.object, field },
    ctx.locale,
  );
}

function isArrayColumn(field: ObjectDefinition["fields"][number]): boolean {
  return (
    field.type === FIELD_TYPES.MULTI_RELATION ||
    (field.type === FIELD_TYPES.ENUM && field.multiple === true) ||
    (field.type === FIELD_TYPES.IMAGE && field.multiple === true)
  );
}

const FILTER_OP_VALUES: readonly string[] = Object.values(FILTER_OPS);

function isFilterValue(v: unknown): v is FilterValue {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).length > 0 &&
    Object.keys(v).every((k) => FILTER_OP_VALUES.includes(k))
  );
}

function fieldOf(
  object: ObjectDefinition,
  name: string,
): ObjectDefinition["fields"][number] | undefined {
  return object.fields.find((f) => f.name === name);
}

function isKnown(
  object: ObjectDefinition,
  ctx: BuildContext,
  name: string,
): boolean {
  const field = fieldOf(object, name);
  if (field !== undefined && field.type !== FIELD_TYPES.DETAILS) return true;
  return ctx.allowParentCols === true && PARENT_COLUMNS.has(name);
}

function conditionSql(
  field: ObjectDefinition["fields"][number],
  op: FilterOp,
  value: unknown,
  idx: number,
): { sql: string; params: unknown[] } {
  const col = q(field.name);
  const p = `$${idx}`;
  switch (op) {
    case FILTER_OPS.EQ:
      return { sql: `${col} = ${p}`, params: [value] };
    case FILTER_OPS.NE:
      return { sql: `${col} <> ${p}`, params: [value] };
    case FILTER_OPS.GT:
      return { sql: `${col} > ${p}`, params: [value] };
    case FILTER_OPS.GTE:
      return { sql: `${col} >= ${p}`, params: [value] };
    case FILTER_OPS.LT:
      return { sql: `${col} < ${p}`, params: [value] };
    case FILTER_OPS.LTE:
      return { sql: `${col} <= ${p}`, params: [value] };
    case FILTER_OPS.IN:
      return { sql: `${col} = ANY(${p})`, params: [value] };
    case FILTER_OPS.CONTAINS:
      return { sql: `${col} @> ${p}::text[]`, params: [value] };
    case FILTER_OPS.LIKE:
      return { sql: `${col} ILIKE ${p}`, params: [`%${value}%`] };
  }
}

/**
 * Build one field condition and append its params. Returns `''` when the
 * condition must be skipped (multi-operator on one field, or `contains` on a
 * non-array column); unknown fields throw via `fail`.
 */
function buildFieldClause(
  object: ObjectDefinition,
  name: string,
  rawValue: unknown,
  ctx: BuildContext,
  params: unknown[],
): string {
  if (!isKnown(object, ctx, name)) fail(ctx, name);
  const field = fieldOf(object, name);
  // parent_* columns have no field definition; treat as plain string columns
  const effective: ObjectDefinition["fields"][number] =
    field ??
    ({ name, type: FIELD_TYPES.STRING } as ObjectDefinition["fields"][number]);

  // `rawValue` is either a bare scalar (`eq`) or a `FilterValue` object of one
  // or more operators on the same field. Multiple operators are AND'd together,
  // which is how a date/time range (`{ gte, lte }`) is expressed.
  let ops: Array<[FilterOp, unknown]>;
  if (isFilterValue(rawValue)) {
    ops = Object.entries(rawValue) as [FilterOp, unknown][];
    for (const [op] of ops) {
      if (op === FILTER_OPS.CONTAINS && !isArrayColumn(effective)) return "";
    }
  } else {
    ops = [[FILTER_OPS.EQ, rawValue]];
  }

  const baseIdx = params.length + 1;
  const pieces: string[] = [];
  for (const [op, value] of ops) {
    const { sql, params: p } = conditionSql(effective, op, value, baseIdx + pieces.length);
    pieces.push(sql);
    params.push(...p);
  }
  if (pieces.length === 0) return "";
  return pieces.length === 1 ? pieces[0]! : `(${pieces.join(" AND ")})`;
}

/** build the WHERE clause (including leading "WHERE" when non-empty); rowScope is AND'd last */
export function buildWhere(
  object: ObjectDefinition,
  filter: Filter | undefined,
  ctx: BuildContext,
  rowScope?: RowScope,
): BuiltQuery {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter !== undefined) {
    const orGroups = filter.$or;
    if (orGroups !== undefined && orGroups.length > 0) {
      const orClauses: string[] = [];
      for (const group of orGroups) {
        const inner: string[] = [];
        for (const [name, rawValue] of Object.entries(group)) {
          const sql = buildFieldClause(object, name, rawValue, ctx, params);
          if (sql !== "") inner.push(sql);
        }
        if (inner.length > 0) orClauses.push(`(${inner.join(" AND ")})`);
      }
      if (orClauses.length > 0) clauses.push(`(${orClauses.join(" OR ")})`);
    }

    for (const [name, rawValue] of Object.entries(filter)) {
      if (name === "$or") continue;
      const sql = buildFieldClause(object, name, rawValue, ctx, params);
      if (sql !== "") clauses.push(sql);
    }
  }

  if (rowScope !== undefined) {
    const scope = scopeSuffix(rowScope, params.length);
    clauses.push(`(${scope.sql})`);
    params.push(...scope.params);
  }

  return {
    sql: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`,
    params,
  };
}

/** build ORDER BY clause (empty when no sort) */
export function buildOrderBy(
  object: ObjectDefinition,
  sort: Sort[] | undefined,
  ctx: BuildContext,
): string {
  if (sort === undefined || sort.length === 0) return "";
  const parts: string[] = [];
  for (const s of sort) {
    if (!isKnown(object, ctx, s.field)) fail(ctx, s.field);
    parts.push(`${q(s.field)} ${s.dir.toUpperCase()}`);
  }
  return ` ORDER BY ${parts.join(", ")}`;
}

/** build SELECT columns (whitelist projection, defaults to all model columns + parent_* for children) */
export function buildColumns(
  object: ObjectDefinition,
  fields: string[] | undefined,
  ctx: BuildContext,
  exclude?: readonly string[],
): string {
  const modelCols = object.fields
    .filter((f) => f.type !== FIELD_TYPES.DETAILS)
    .map((f) => f.name);
  const allCols = [
    ...modelCols,
    ...(ctx.allowParentCols === true ? [...PARENT_COLUMNS] : []),
  ];
  const isExcluded = (name: string) =>
    exclude !== undefined && exclude.includes(name);
  if (fields === undefined) {
    return allCols
      .filter((c) => !isExcluded(c))
      .map(q)
      .join(", ");
  }
  for (const name of fields) {
    if (!allCols.includes(name)) fail(ctx, name);
  }
  return fields
    .filter((c) => !isExcluded(c))
    .map(q)
    .join(", ");
}

/** resolve pagination with defaults/caps */
export function resolvePagination(opts: FindOptions): {
  limit: number;
  offset: number;
} {
  const limit = Math.min(
    opts.limit ?? PAGINATION.DEFAULT_LIMIT,
    PAGINATION.MAX_LIMIT,
  );
  const offset = Math.max(opts.offset ?? PAGINATION.DEFAULT_OFFSET, 0);
  return { limit, offset };
}

/** full SELECT query */
export function buildFindSql(
  object: ObjectDefinition,
  opts: FindOptions,
  ctx: BuildContext,
  rowScope?: RowScope,
  exclude?: readonly string[],
): BuiltQuery {
  const table = q(object.name);
  const cols = buildColumns(object, opts.fields, ctx, exclude);
  const { sql: where, params } = buildWhere(object, opts.filter, ctx, rowScope);
  const orderBy = buildOrderBy(object, opts.sort, ctx);
  const { limit, offset } = resolvePagination(opts);
  const sql = `SELECT ${cols} FROM ${table} ${where}${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  return { sql, params: [...params, limit, offset] };
}

/** COUNT query for total (same filter, no sort/pagination) */
export function buildCountSql(
  object: ObjectDefinition,
  opts: FindOptions,
  ctx: BuildContext,
  rowScope?: RowScope,
): BuiltQuery {
  const table = q(object.name);
  const { sql: where, params } = buildWhere(object, opts.filter, ctx, rowScope);
  return {
    sql: `SELECT COUNT(*)::int AS total FROM ${table} ${where}`,
    params,
  };
}

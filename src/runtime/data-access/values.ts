/**
 * Single source of truth for data-access layer constants.
 * Union types are derived via `typeof X[keyof typeof X]`; consumers must not
 * hardcode the literal values.
 */

/** filter operators (eq/ne/gt/gte/lt/lte/in/contains/like) */
export const FILTER_OPS = {
  EQ: "eq",
  NE: "ne",
  GT: "gt",
  GTE: "gte",
  LT: "lt",
  LTE: "lte",
  IN: "in",
  /** array column overlap: `col @> value::text[]` (multi-enum) */
  CONTAINS: "contains",
  /** case-insensitive substring: `col ILIKE '%value%'` (scalar string) */
  LIKE: "like",
} as const;
export type FilterOp = (typeof FILTER_OPS)[keyof typeof FILTER_OPS];

/** sort directions */
export const SORT_DIRS = {
  ASC: "asc",
  DESC: "desc",
} as const;
export type SortDir = (typeof SORT_DIRS)[keyof typeof SORT_DIRS];

/** write modes for validateRecord (create/update) */
export const WRITE_MODES = {
  CREATE: "create",
  UPDATE: "update",
} as const;
export type WriteMode = (typeof WRITE_MODES)[keyof typeof WRITE_MODES];

/** pagination defaults */
export const PAGINATION = {
  DEFAULT_LIMIT: 100,
  MAX_LIMIT: 1000,
  DEFAULT_OFFSET: 0,
} as const;

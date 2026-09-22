import type { FieldDefinition } from './fields.js';
import type { Permissions } from './permission.js';
import type { IndexType } from './values.js';

/** a user-declared extra index */
export interface IndexDefinition {
  type: IndexType;
  fields: string[];
}

/** a validated object definition (the engine's core metadata unit) */
export interface ObjectDefinition {
  /**
   * on-disk `schema.json` format version (see `core/object/schema-version.ts`).
   * Absent on legacy unversioned files; `weave schema:upgrade` stamps it.
   */
  schemaVersion?: number;
  name: string;
  /**
   * display names keyed by locale, e.g. { en: 'Customer', zh: '客户' } — the single
   * source of truth for the object's human-readable name. Resolve with
   * `resolveLabel` (falls back to `name` when absent).
   */
  labels?: Record<string, string>;
  description?: string;
  fields: FieldDefinition[];
  permissions?: Permissions;
  workflow?: unknown;
  indexes?: IndexDefinition[];
  /** composite title template, e.g. "{doc_no} {customer_name}" */
  titleTemplate?: string;
  /**
   * opt-in additive auto-DDL for this object's existing table (default false).
   * When true, `weave migrate` and `weave dev` reload emit ADD COLUMN /
   * CONSTRAINT / FK / INDEX for schema changes on an existing table. When
   * false (default) an existing table is read-only — a declared field missing
   * a column fails the sync (fail-fast, protects user-owned tables).
   */
  alter?: boolean;
}

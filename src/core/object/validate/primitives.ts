import type { Locale, MessageKey } from '../../i18n/index.js';
import { SchemaError } from '../../types/errors.js';
import {
  FIELD_TYPES,
  INDEX_TYPES,
  ON_DELETE_ACTIONS,
  SCALAR_FIELD_TYPES,
  SEQUENCE_CYCLES,
  SEQUENCE_TOKENS,
} from '../../types/values.js';

/**
 * Shared validation primitives: the validation context, the localized-fail
 * helper, small attribute readers, and the value-array/regex constants reused
 * across the object validators.
 */

/** validation context: object being validated + active locale */
export interface Vc {
  object: string;
  locale: Locale;
}

export function fail(vc: Vc, code: MessageKey, params: Record<string, unknown> = {}): never {
  throw new SchemaError(code, { object: vc.object, ...params }, vc.locale);
}

/** type guard: plain object (not array/null) */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** read an optional string attribute; fails with a localized error if present but not a string */
export function expectString(record: Record<string, unknown>, key: string, vc: Vc): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(vc, 'field.attr.string', { attr: key });
  return value;
}

/** read an optional boolean attribute; fails if present but not boolean */
export function expectBoolean(record: Record<string, unknown>, key: string, vc: Vc): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') fail(vc, 'field.attr.boolean', { attr: key });
  return value;
}

/** read an optional numeric attribute; fails if present but not a finite number */
export function expectNumber(record: Record<string, unknown>, key: string, vc: Vc): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || Number.isNaN(value)) fail(vc, 'field.attr.number', { attr: key });
  return value;
}

/** read an optional positive integer attribute (used for lengths/precision/padding) */
export function expectPositiveInt(record: Record<string, unknown>, key: string, vc: Vc): number | undefined {
  const value = expectNumber(record, key, vc);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) fail(vc, 'field.attr.positiveInt', { attr: key });
  return value;
}

export const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

export const LOCALE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export const FIELD_TYPE_VALUES: readonly string[] = Object.values(FIELD_TYPES);
export const ON_DELETE_ACTION_VALUES: readonly string[] = Object.values(ON_DELETE_ACTIONS);
export const INDEX_TYPE_VALUES: readonly string[] = Object.values(INDEX_TYPES);
export const SCALAR_TYPE_VALUES: readonly string[] = Object.values(SCALAR_FIELD_TYPES);
export const SEQUENCE_TOKEN_VALUES: readonly string[] = Object.values(SEQUENCE_TOKENS);
export const SEQUENCE_CYCLE_VALUES: readonly string[] = Object.values(SEQUENCE_CYCLES);

export const SEQUENCE_PLACEHOLDER = /\{seq(?::\d+)?\}/;

/** placeholders allowed in titleTemplate */
export const TITLE_PLACEHOLDER_RE = /\{(\w+)\}/g;

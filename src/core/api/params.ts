import type { Locale } from '../i18n/index.js';
import { SchemaError } from '../types/errors.js';
import type { ApiSort, ListQuery } from './types.js';

function invalid(param: string, locale: Locale | undefined): never {
  throw new SchemaError('http.param.invalid', { param }, locale);
}

function parseFilter(raw: string, locale: Locale | undefined): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    invalid('filter', locale);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid('filter', locale);
  }
  return value as Record<string, unknown>;
}

function parseSort(raw: string, locale: Locale | undefined): ApiSort[] {
  const out: ApiSort[] = [];
  for (const token of raw.split(',')) {
    const trimmed = token.trim();
    if (trimmed === '') continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) {
      out.push({ field: trimmed, direction: 'asc' });
      continue;
    }
    const field = trimmed.slice(0, idx).trim();
    const direction = trimmed.slice(idx + 1).trim();
    if (field === '' || direction === '') invalid('sort', locale);
    out.push({ field, direction });
  }
  return out;
}

function parseFields(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function parseIntParam(raw: string, param: string, locale: Locale | undefined): number {
  if (!/^-?\d+$/.test(raw)) invalid(param, locale);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) invalid(param, locale);
  return n;
}

function readString(query: Record<string, unknown>, key: string, locale: Locale | undefined): string | undefined {
  const raw = query[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') invalid(key, locale);
  return raw;
}

/**
 * Parse a REST list query string into a neutral {@link ListQuery}.
 * Syntax only (JSON decode, comma splitting, integer check) — field existence,
 * sort direction and pagination caps are enforced by the adapter layer that
 * maps the result onto the data-access contracts.
 */
export function parseFindParams(
  query: Record<string, unknown>,
  locale?: Locale,
): ListQuery {
  const out: ListQuery = {};
  const filter = readString(query, 'filter', locale);
  if (filter !== undefined) out.filter = parseFilter(filter, locale);
  const sort = readString(query, 'sort', locale);
  if (sort !== undefined) out.sort = parseSort(sort, locale);
  const fields = readString(query, 'fields', locale);
  if (fields !== undefined) out.fields = parseFields(fields);
  const limit = readString(query, 'limit', locale);
  if (limit !== undefined) out.limit = parseIntParam(limit, 'limit', locale);
  const offset = readString(query, 'offset', locale);
  if (offset !== undefined) out.offset = parseIntParam(offset, 'offset', locale);
  return out;
}

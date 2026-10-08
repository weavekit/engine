import { SchemaError } from '../../core/index.js';

/** cursor payload version (bumped if the encoding changes) */
export const CURSOR_VERSION = 1;

interface CursorPayload {
  v: number;
  /** ordered key values (currently: the single primary key value) */
  k: unknown[];
}

/**
 * Opaque, URL-safe keyset cursor (base64url of `{ v, k }`). Callers treat it as
 * a token; only this module knows the shape. Values are the raw primary key
 * values (string/number) so a keyset predicate can re-use them directly.
 */
export function encodeCursor(values: readonly unknown[]): string {
  const payload: CursorPayload = { v: CURSOR_VERSION, k: [...values] };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** decode a cursor; malformed/foreign cursors → `http.param.invalid` (400) */
export function decodeCursor(cursor: string): unknown[] {
  try {
    const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
    if (payload.v !== CURSOR_VERSION || !Array.isArray(payload.k) || payload.k.length === 0) {
      throw new Error('bad cursor');
    }
    return payload.k;
  } catch {
    throw new SchemaError('http.param.invalid', { param: 'cursor' });
  }
}

import { SchemaError } from '../types/errors.js';

/**
 * Record identity encoding.
 *
 * A record is identified by its (possibly composite) primary-key value tuple.
 * `record_key` is a single, self-describing, decodable string so it can be used
 * as a URL/MCP path parameter, a single-column side-table primary key, and a
 * cross-object reference value — **without** adding a surrogate column to a
 * customer table.
 *
 * Encoding = length-prefix concatenation: each element is
 * `${utf8ByteLength(value)}:${value}`. The length is in UTF-8 **bytes** (not
 * UTF-16 code units), so values containing `:` (ISO timestamps, clock times) or
 * any other character stay unambiguous — the decoder reads the declared byte
 * count instead of scanning for a delimiter.
 *
 *   encodeRecordKey(['O-1001', '3']) === '6:O-10011:3'
 *   decodeRecordKey('6:O-10011:3')   === ['O-1001', '3']
 *
 * The encoding is a bijection over ordered string tuples (a value may itself
 * contain `:` without ambiguity).
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const COLON = 0x3a; // ':'
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** throw a localized `recordKey.invalid` */
function invalid(key: string): never {
  throw new SchemaError('recordKey.invalid', { key });
}

/** encode an ordered primary-key value tuple into a single record key */
export function encodeRecordKey(values: readonly string[]): string {
  let out = '';
  for (const value of values) {
    out += `${textEncoder.encode(value).length}:${value}`;
  }
  return out;
}

/** decode a record key back into its ordered primary-key value tuple */
export function decodeRecordKey(key: string): string[] {
  const bytes = textEncoder.encode(key);
  const values: string[] = [];
  let cursor = 0;

  while (cursor < bytes.length) {
    let colon = -1;
    for (let i = cursor; i < bytes.length; i += 1) {
      if (bytes[i] === COLON) {
        colon = i;
        break;
      }
    }
    if (colon === -1) invalid(key);

    const lengthText = textDecoder.decode(bytes.subarray(cursor, colon));
    if (!DECIMAL.test(lengthText)) invalid(key);

    const length = Number(lengthText);
    const start = colon + 1;
    const end = start + length;
    if (end > bytes.length) invalid(key);

    values.push(textDecoder.decode(bytes.subarray(start, end)));
    cursor = end;
  }

  return values;
}

/**
 * Canonicalize a scalar primary-key value so the same record always yields the
 * same key. Temporal values must already be in canonical form — the data-access
 * layer reads them via `to_char` (session-independent, microsecond precision) to
 * avoid millisecond truncation and timezone drift; this helper only normalizes
 * plain JS scalars and is a no-op for strings.
 */
export function canonicalizePrimaryValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  invalid(String(value));
}

/**
 * Encode the primary-key tuple of a record (field names in declaration order)
 * into its record key. Values are canonicalized individually.
 */
export function recordKeyOf(
  primaryFields: readonly string[],
  record: Record<string, unknown>,
): string {
  return encodeRecordKey(primaryFields.map((name) => canonicalizePrimaryValue(record[name])));
}

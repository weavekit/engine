import { describe, it, expect } from '../helpers/test.js';
import {
  encodeRecordKey,
  decodeRecordKey,
  canonicalizePrimaryValue,
  recordKeyOf,
} from '../../src/core/object/record-key.js';
import { parseSchema } from '../../src/core/index.js';

/** minimal object with a single primary field of the given type */
function objWithPrimary(primaryType: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'sample',
    fields: [{ name: 'id', type: primaryType, primary: true, ...extra }],
  });
}

describe('record_key encoding', () => {
  it('encodes single and composite tuples with a length prefix', () => {
    expect(encodeRecordKey(['O-1001'])).toBe('6:O-1001');
    expect(encodeRecordKey(['O-1001', '3'])).toBe('6:O-10011:3');
  });

  it('round-trips arbitrarily typed values', () => {
    const tuples = [
      [],
      ['a'],
      ['', ''],
      ['O-1001', '3'],
      ['2026-09-26T10:30:00.000000Z', '3'],
      ['2026-09-26 10:30:00', 'x:y:z'],
      ['订单', '🙂'],
      ['5:12:341:x'],
    ];
    for (const tuple of tuples) {
      expect(decodeRecordKey(encodeRecordKey(tuple))).toEqual(tuple);
    }
  });

  it('treats colons inside values as data, not delimiters', () => {
    expect(encodeRecordKey(['2026-09-26T10:30:00.000000Z'])).toBe(
      '27:2026-09-26T10:30:00.000000Z',
    );
    expect(decodeRecordKey('27:2026-09-26T10:30:00.000000Z')).toEqual([
      '2026-09-26T10:30:00.000000Z',
    ]);
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // "订单" is 2 chars but 6 UTF-8 bytes
    expect(encodeRecordKey(['订单'])).toBe('6:订单');
    expect(decodeRecordKey('6:订单')).toEqual(['订单']);
  });

  it('rejects malformed keys', () => {
    expect(() => decodeRecordKey('no-colon')).toThrow();
    expect(() => decodeRecordKey('01:a')).toThrow();
    expect(() => decodeRecordKey('x:a')).toThrow();
    expect(() => decodeRecordKey('9:abc')).toThrow();
    expect(() => decodeRecordKey('2:abcd')).toThrow();
  });
});

describe('canonicalizePrimaryValue', () => {
  it('normalizes plain scalars', () => {
    expect(canonicalizePrimaryValue('O-1001')).toBe('O-1001');
    expect(canonicalizePrimaryValue(true)).toBe('true');
    expect(canonicalizePrimaryValue(false)).toBe('false');
    expect(canonicalizePrimaryValue(42)).toBe('42');
    expect(canonicalizePrimaryValue(10n)).toBe('10');
    expect(canonicalizePrimaryValue(new Date('2026-09-26T10:30:00.000Z'))).toBe(
      '2026-09-26T10:30:00.000Z',
    );
  });
});

describe('recordKeyOf', () => {
  it('encodes the tuple of declared primary fields', () => {
    expect(recordKeyOf(['order_no', 'line_no'], { order_no: 'O-1001', line_no: '3' })).toBe(
      '6:O-10011:3',
    );
  });
});

describe('temporal / primary-key validation', () => {
  it('resolves the deprecated `datetime` alias to `timestamptz`', () => {
    const def = parseSchema(objWithPrimary('datetime'));
    expect(def.fields[0]?.type).toBe('timestamptz');
  });

  it('accepts timezone-less `timestamp` as a primary key', () => {
    const def = parseSchema(objWithPrimary('timestamp'));
    expect(def.fields[0]?.type).toBe('timestamp');
  });

  it('accepts date/time/timetz primary keys', () => {
    for (const type of ['date', 'time', 'timetz']) {
      expect(parseSchema(objWithPrimary(type)).fields[0]?.type).toBe(type);
    }
  });

  it('rejects json and interval primary keys', () => {
    expect(() => parseSchema(objWithPrimary('json'))).toThrow();
    expect(() => parseSchema(objWithPrimary('interval'))).toThrow();
  });
});

import { describe, it, expect } from '../helpers/test.js';import {
  checkOperands,
  evaluate,
  parseFormula,
  type FormulaEvalContext,
} from '../../src/core/index.js';

const ctx = (record: Record<string, unknown>, extra?: Partial<FormulaEvalContext>): FormulaEvalContext => ({
  record,
  resolveRef: () => null,
  resolveAggregate: () => [],
  now: () => new Date('2026-08-05T00:00:00Z'),
  ...extra,
});

describe('parseFormula — syntax', () => {
  it('arithmetic and parentheses', () => {
    expect(evaluate(parseFormula('2 * (3 + 4)'), ctx({}))).toBe(14);
    expect(evaluate(parseFormula('10 % 3'), ctx({}))).toBe(1);
  });

  it('field references', () => {
    expect(evaluate(parseFormula('unit_price * qty'), ctx({ unit_price: 2, qty: 3 }))).toBe(6);
  });

  it('string concatenation &', () => {
    expect(evaluate(parseFormula("first_name & ' ' & last_name"), ctx({ first_name: '张三', last_name: '李' }))).toBe('张三 李');
  });

  it('comparison and logic', () => {
    expect(evaluate(parseFormula('amount >= 10000 AND status == "approved"'), ctx({ amount: 20000, status: 'approved' }))).toBe(true);
    expect(evaluate(parseFormula('amount >= 10000 OR status == "open"'), ctx({ amount: 5, status: 'open' }))).toBe(true);
  });

  it('IF / ROUND / NOW / CONCAT', () => {
    expect(evaluate(parseFormula('IF(amount > 10, "big", "small")'), ctx({ amount: 20 }))).toBe('big');
    expect(evaluate(parseFormula('ROUND(1.2345, 2)'), ctx({}))).toBe(1.23);
    expect(String(evaluate(parseFormula('NOW()'), ctx({})))).toBe(new Date('2026-08-05T00:00:00Z').toString());
    expect(evaluate(parseFormula('CONCAT("a", "b", "c")'), ctx({}))).toBe('abc');
  });

  it('aggregates COUNT/SUM', () => {
    expect(
      evaluate(parseFormula('SUM(lines.qty)'), ctx({}, {
        resolveAggregate: (parent, name) => (parent === 'lines' && name === 'qty' ? [1, 2, 3] : []),
      })),
    ).toBe(6);
    expect(
      evaluate(parseFormula('COUNT(lines)'), ctx({}, {
        resolveAggregate: () => [1, 2, 3],
      })),
    ).toBe(3);
  });

  it('null semantics', () => {
    expect(evaluate(parseFormula('missing * 2'), ctx({}))).toBe(null);
    expect(evaluate(parseFormula('missing > 1'), ctx({}))).toBe(false);
    expect(evaluate(parseFormula('name & "!"'), ctx({ name: null }))).toBe('!');
  });

  it('syntax errors throw FormulaError', () => {
    expect(() => parseFormula('1 +')).toThrow();
    expect(() => parseFormula('(1 + 2')).toThrow();
    expect(() => parseFormula('1 @ 2')).toThrow();
  });
});

describe('formula functions (catalog)', () => {
  it('string functions', () => {
    expect(evaluate(parseFormula('LOWER("AbC")'), ctx({}))).toBe('abc');
    expect(evaluate(parseFormula('UPPER("AbC")'), ctx({}))).toBe('ABC');
    expect(evaluate(parseFormula('TRIM("  x  ")'), ctx({}))).toBe('x');
    expect(evaluate(parseFormula('LENGTH("abcd")'), ctx({}))).toBe(4);
    expect(evaluate(parseFormula('SUBSTR("abcdef", 1, 3)'), ctx({}))).toBe('bcd');
    expect(evaluate(parseFormula('SUBSTR("abcdef", 2)'), ctx({}))).toBe('cdef');
    expect(evaluate(parseFormula('REPLACE("a-b-a", "a", "X")'), ctx({}))).toBe('X-b-X');
  });

  it('numeric functions', () => {
    expect(evaluate(parseFormula('ABS(0 - 3)'), ctx({}))).toBe(3);
    expect(evaluate(parseFormula('ABS(-3)'), ctx({}))).toBe(3);
    expect(evaluate(parseFormula('FLOOR(1.9)'), ctx({}))).toBe(1);
    expect(evaluate(parseFormula('CEIL(1.1)'), ctx({}))).toBe(2);
    expect(evaluate(parseFormula('POW(2, 10)'), ctx({}))).toBe(1024);
  });

  it('coalesce returns the first non-null', () => {
    expect(evaluate(parseFormula('COALESCE(missing, name, "x")'), ctx({ name: null }))).toBe('x');
    expect(evaluate(parseFormula('COALESCE(missing, name)'), ctx({ name: 'Ann' }))).toBe('Ann');
    expect(evaluate(parseFormula('COALESCE(missing)'), ctx({}))).toBe(null);
  });

  it('null propagation for string/numeric functions', () => {
    expect(evaluate(parseFormula('LOWER(missing)'), ctx({}))).toBe(null);
    expect(evaluate(parseFormula('ABS(missing)'), ctx({}))).toBe(null);
  });

  it('arity violations throw at validation', () => {
    const f = (s: string): void => checkOperands(parseFormula(s), () => undefined);
    expect(() => f('ABS(1, 2)')).toThrow();
    expect(() => f('REPLACE("a", "b")')).toThrow();
    expect(() => f('POW(1)')).toThrow();
    expect(() => f('SUBSTR("a")')).toThrow();
    expect(() => f('NOPE(1)')).toThrow();
  });
});

import { describe, it, expect } from '../helpers/test.js';import {
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

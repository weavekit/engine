import { describe, it, expect } from '../helpers/test.js';
import {
  BUILTIN_CUSTOM_FIELD_TYPES,
  FIELD_TYPES,
  OPT_IN_FIELD_TYPES,
  PG_FIELD_TYPES,
  PRIMITIVE_FIELD_TYPES,
} from '../../src/core/index.js';

describe('field-type taxonomy', () => {
  it('PG-native + custom buckets partition FIELD_TYPES without overlap', () => {
    const pg = Object.values(PG_FIELD_TYPES);
    const custom = Object.values(BUILTIN_CUSTOM_FIELD_TYPES);
    expect([...pg, ...custom].sort()).toEqual(Object.values(FIELD_TYPES).sort());
    expect(new Set(pg).size).toBe(pg.length);
    expect(new Set(custom).size).toBe(custom.length);
    expect(pg.filter((t) => custom.includes(t))).toEqual([]);
    // currency is an engine custom type, not a PG-native passthrough
    expect(pg).not.toContain('currency');
    expect(custom).toContain('currency');
  });

  it('behavior lists: primitives are always-on, opt-in is gated', () => {
    expect(PRIMITIVE_FIELD_TYPES).toContain('currency');
    expect(OPT_IN_FIELD_TYPES).toContain('user');
    expect(OPT_IN_FIELD_TYPES).toContain('department');
    // disjoint + exhaustive over the built-in set
    expect(PRIMITIVE_FIELD_TYPES.length + OPT_IN_FIELD_TYPES.length).toBe(Object.values(FIELD_TYPES).length);
    expect(PRIMITIVE_FIELD_TYPES.filter((t) => OPT_IN_FIELD_TYPES.includes(t))).toEqual([]);
  });
});

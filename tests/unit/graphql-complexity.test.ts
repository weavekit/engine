import { describe, it, expect } from '../helpers/test.js';
import { parse } from 'graphql';
import { SchemaError } from '../../src/core/index.js';
import { resolveSecurity, validateQuery } from '../../src/adapters/graphql/security.js';

describe('GraphQL complexity is weighted by list limit (W4)', () => {
  it('a large `limit` raises the cost above maxComplexity', () => {
    const security = resolveSecurity({ maxComplexity: 50 });
    let caught: unknown;
    try {
      validateQuery(parse('{ lead(limit: 100) { id } }'), security, 'en');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchemaError);
    expect((caught as SchemaError).code).toBe('graphql.complexityExceeded');
  });

  it('a field without limit costs 1 (stays under the budget)', () => {
    const security = resolveSecurity({ maxComplexity: 50 });
    expect(() => validateQuery(parse('{ lead { id } }'), security, 'en')).not.toThrow();
  });

  it('cost is capped at the pagination ceiling', () => {
    const security = resolveSecurity({ maxComplexity: 1000 });
    expect(() => validateQuery(parse('{ lead(limit: 5000) }'), security, 'en')).not.toThrow(); // capped to 1000
    expect(() => validateQuery(parse('{ lead(limit: 5000) { id } }'), security, 'en')).toThrow(); // 1001
  });
});

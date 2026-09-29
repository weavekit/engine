import { describe, it, expect } from '../helpers/test.js';
import { parseSchema } from '../../src/core/index.js';

const withStatus = (status: Record<string, unknown>): string =>
  JSON.stringify({
    name: 'lead',
    fields: [
      { name: 'id', type: 'string', primary: true },
      { name: 'status', ...status },
    ],
  });

describe('native enum type derivation', () => {
  it('derives `<object>_<field>` for a static inline enum', () => {
    const def = parseSchema(withStatus({ type: 'enum', options: ['open', 'closed'] }));
    const status = def.fields.find((f) => f.name === 'status') as { enumType?: string };
    expect(status.enumType).toBe('lead_status');
  });

  it('keeps a declared enumType', () => {
    const def = parseSchema(withStatus({ type: 'enum', options: ['open'], enumType: 'order_status' }));
    const status = def.fields.find((f) => f.name === 'status') as { enumType?: string };
    expect(status.enumType).toBe('order_status');
  });

  it('does not derive for a data-driven enum', () => {
    const def = parseSchema(
      JSON.stringify({
        name: 'lead',
        fields: [
          { name: 'id', type: 'string', primary: true },
          { name: 'status', type: 'enum', options: { from: { object: 'lead', column: 'id' } } },
        ],
      }),
    );
    const status = def.fields.find((f) => f.name === 'status') as { enumType?: string };
    expect(status.enumType).toBeUndefined();
  });

  it('rejects an enumType that is not a snake_case identifier (DDL injection guard)', () => {
    let caught: unknown;
    try {
      parseSchema(withStatus({ type: 'enum', options: ['open'], enumType: 'lead"; DROP TABLE x; --' }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe('field.enum.enumType.invalid');
  });
});

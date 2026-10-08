import { describe, it, expect } from '../helpers/test.js';
import { computeSchemaHash } from '../../src/runtime/metadata/index.js';

describe('computeSchemaHash', () => {
  it('is deterministic and order-independent', () => {
    const a = computeSchemaHash([
      { name: 'a', contentHash: '1' },
      { name: 'b', contentHash: '2' },
    ]);
    const b = computeSchemaHash([
      { name: 'b', contentHash: '2' },
      { name: 'a', contentHash: '1' },
    ]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when a content hash changes', () => {
    const a = computeSchemaHash([{ name: 'a', contentHash: '1' }]);
    const b = computeSchemaHash([{ name: 'a', contentHash: '2' }]);
    expect(a).not.toBe(b);
  });

  it('an empty schema has a stable hash', () => {
    expect(computeSchemaHash([])).toBe(computeSchemaHash([]));
  });
});

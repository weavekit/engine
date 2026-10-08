import { describe, it, expect } from '../helpers/test.js';
import { validateToolArgs, EXECUTION_STAGES, NOOP_EVIDENCE_SINK } from '../../src/core/index.js';
import type { ToolJsonSchema } from '../../src/core/index.js';

const schema: ToolJsonSchema = {
  type: 'object',
  required: ['object', 'data'],
  additionalProperties: false,
  properties: {
    object: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    kind: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' } },
    data: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
};

describe('validateToolArgs', () => {
  it('accepts a valid payload', () => {
    expect(validateToolArgs({ object: 'lead', data: { id: 'L1' }, limit: 5, tags: ['x'] }, schema).ok).toBe(true);
  });

  it('rejects missing required', () => {
    const r = validateToolArgs({ object: 'lead' }, schema);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('data is required');
  });

  it('rejects wrong type / enum / range', () => {
    expect(validateToolArgs({ object: 1, data: { id: 'x' } }, schema).ok).toBe(false);
    expect(validateToolArgs({ object: 'lead', data: { id: 'x' }, kind: 'c' }, schema).detail).toContain('must be one of');
    expect(validateToolArgs({ object: 'lead', data: { id: 'x' }, limit: 200 }, schema).detail).toContain('<= 100');
  });

  it('rejects unknown keys when additionalProperties is false', () => {
    expect(validateToolArgs({ object: 'lead', data: { id: 'x' }, ghost: 1 }, schema).detail).toContain('ghost is not allowed');
  });

  it('validates nested objects and array items', () => {
    expect(validateToolArgs({ object: 'lead', data: {} }, schema).detail).toContain('data.id is required');
    expect(validateToolArgs({ object: 'lead', data: { id: 'x' }, tags: ['a', 2] }, schema).detail).toContain('tags[1]');
  });
});

describe('execution pipeline contract', () => {
  it('exposes stage constants + a no-op evidence sink', async () => {
    expect(Object.values(EXECUTION_STAGES)).toContain('guardrail');
    await expect(NOOP_EVIDENCE_SINK.record({} as never)).resolves.toBeUndefined();
  });
});

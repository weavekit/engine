import { describe, it, expect } from '../helpers/test.js';
import { parseTraceparent, traceIdOf } from '../../src/core/trace.js';

const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('W3C traceparent parsing', () => {
  it('parses a valid traceparent', () => {
    const ctx = parseTraceparent(VALID);
    expect(ctx?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(ctx?.spanId).toBe('00f067aa0ba902b7');
    expect(ctx?.sampled).toBe(true);
  });

  it('reports the sampled flag', () => {
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00')?.sampled).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    expect(traceIdOf(`  ${VALID}  `)).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('rejects missing / malformed / unsupported values', () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent(null)).toBeUndefined();
    expect(parseTraceparent('')).toBeUndefined();
    expect(parseTraceparent('not-a-traceparent')).toBeUndefined();
    // all-zero trace id / span id are invalid
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeUndefined();
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01')).toBeUndefined();
    // version `ff` is forbidden; uppercase hex is invalid
    expect(parseTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeUndefined();
    expect(parseTraceparent('00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01')).toBeUndefined();
  });

  it('traceIdOf returns just the id (or undefined)', () => {
    expect(traceIdOf(VALID)).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(traceIdOf('garbage')).toBeUndefined();
  });
});

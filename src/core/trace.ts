/**
 * W3C Trace Context (`traceparent`) — protocol-neutral parsing + correlation.
 *
 * The engine does not generate spans; it parses an inbound `traceparent` header
 * into a `traceId` and threads it through audit / evidence / events so an
 * upstream (or a future enterprise telemetry sink) can correlate a request end
 * to end. A missing or malformed header yields no trace context — correlation
 * is best-effort and never fails a request.
 */

/** parsed W3C trace context (the subset the engine correlates on) */
export interface TraceContext {
  /** 32-hex trace id */
  traceId: string;
  /** 16-hex parent span id */
  spanId: string;
  /** sampled flag (traceparent flags bit 0) */
  sampled: boolean;
  /** the normalized header value (for outbound propagation) */
  traceparent: string;
}

/** version(2)-traceId(32)-spanId(16)-flags(2), optional trailing fields */
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(?:-.*)?$/;

function isAllZero(hex: string): boolean {
  return /^0+$/.test(hex);
}

/**
 * Parse a W3C `traceparent` header. Returns `undefined` for a missing header or
 * any invalid/unsupported value (`ff` version, all-zero trace/span id, wrong
 * shape) — callers treat that as "no trace context".
 */
export function parseTraceparent(header: string | undefined | null): TraceContext | undefined {
  if (typeof header !== 'string') return undefined;
  const value = header.trim();
  const match = TRACEPARENT_RE.exec(value);
  if (match === null) return undefined;
  const version = match[1] ?? '';
  const traceId = match[2] ?? '';
  const spanId = match[3] ?? '';
  const flags = match[4] ?? '';
  if (version === 'ff') return undefined;
  if (isAllZero(traceId) || isAllZero(spanId)) return undefined;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 0x01) === 0x01, traceparent: value };
}

/** the trace id of an inbound `traceparent` header, else `undefined` */
export function traceIdOf(header: string | undefined | null): string | undefined {
  return parseTraceparent(header)?.traceId;
}

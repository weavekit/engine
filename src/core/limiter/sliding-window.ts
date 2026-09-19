/**
 * Generic sliding-window rate limiter (core, zero dependencies). Shared by the
 * MCP guardrails and the REST adapter so both endpoints throttle by the same
 * algorithm. Instances are created per caller (REST and MCP keep their own).
 */

export interface SlidingWindow {
  /** record a hit for `key`; returns true when within the limit, false when exceeded */
  check(key: string, now?: number): boolean;
  /** drop all recorded hits (used on shutdown / reset) */
  clear(): void;
}

export interface SlidingWindowOptions {
  /** window length in ms; defaults to 60_000 */
  windowMs?: number;
  /** max hits per window; defaults to 100 */
  max?: number;
}

/** in-memory sliding-window limiter keyed by an arbitrary string (agent key, ...) */
export function createSlidingWindow(options: SlidingWindowOptions = {}): SlidingWindow {
  const windowMs = options.windowMs ?? 60_000;
  const max = options.max ?? 100;
  const hits = new Map<string, number[]>();

  function check(key: string, now: number = Date.now()): boolean {
    const window = hits.get(key) ?? [];
    const cutoff = now - windowMs;
    while (window.length > 0 && window[0]! <= cutoff) window.shift();
    if (window.length >= max) return false;
    window.push(now);
    hits.set(key, window);
    return true;
  }

  return {
    check,
    clear() {
      hits.clear();
    },
  };
}

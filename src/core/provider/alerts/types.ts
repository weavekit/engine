/**
 * Alert provider contract — pure interface, zero dependencies. The
 * implementations (console / webhook / slack) live in `infrastructure/alerts`
 * and are injected by the assembly layer; adapter layers depend on this
 * contract only.
 */

/** alert severity — single source of truth (as const, see AGENTS.md) */
export const ALERT_LEVELS = {
  WARN: 'warn',
  ERROR: 'error',
} as const;
export type AlertLevel = typeof ALERT_LEVELS[keyof typeof ALERT_LEVELS];

/**
 * Alert sink contract. Implementations must surface delivery failures as
 * thrown errors so callers (e.g. guardrails) can catch and continue the
 * business path — alerting is best-effort, never blocks the request.
 */
export interface AlertSink {
  alert(level: AlertLevel, message: string, meta?: Record<string, unknown>): Promise<void>;
}

/**
 * Minimal injectable HTTP transport for webhook-style sinks. Narrower than
 * `typeof fetch` (runtime-specific extra props like Bun's `preconnect`) so
 * mocks stay trivially constructible; defaults to the global fetch.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;


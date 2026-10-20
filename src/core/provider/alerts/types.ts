/**
 * Deprecated alert provider contract. The alert transports were folded into
 * `core/provider/notifications` / `infrastructure/notifications`; this file
 * remains only for 2.x source compatibility and is removed in engine 3.0.
 */

/**
 * @deprecated Use `NOTIFICATION_SEVERITIES` from
 * `core/provider/notifications`; removed in engine 3.0.
 */
export const ALERT_LEVELS = {
  WARN: 'warn',
  ERROR: 'error',
} as const;
export type AlertLevel = typeof ALERT_LEVELS[keyof typeof ALERT_LEVELS];

/**
 * @deprecated Use `NotificationSink` from `core/provider/notifications`.
 * This contract remains only for 2.x compatibility; it will be removed in
 * engine 3.0.
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


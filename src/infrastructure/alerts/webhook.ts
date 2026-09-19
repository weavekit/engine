import type { AlertSink, FetchLike } from '../../core/provider/alerts/index.js';
import type { AlertLevel } from '../../core/provider/alerts/index.js';

export interface WebhookAlertSinkOptions {
  /** target URL receiving a JSON POST per alert */
  url: string;
  /** extra headers, e.g. an Authorization token */
  headers?: Record<string, string>;
  /** request timeout in ms; defaults to 5000 */
  timeoutMs?: number;
  /** fetch implementation, injectable for tests; defaults to the global fetch */
  fetch?: FetchLike;
}

/**
 * Generic webhook alert sink — POSTs `{ level, message, meta, ts }` as JSON.
 * Delivery failures (non-2xx, network errors, timeout) throw; callers catch
 * and keep the business path moving.
 */
export function createWebhookAlertSink(options: WebhookAlertSinkOptions): AlertSink {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const headers = { 'content-type': 'application/json', ...options.headers };
  return {
    async alert(level: AlertLevel, message: string, meta?: Record<string, unknown>) {
      const res = await doFetch(options.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ level, message, meta, ts: new Date().toISOString() }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`webhook alert failed: ${res.status} ${res.statusText}`);
      }
    },
  };
}

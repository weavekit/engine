import type { AlertSink, FetchLike } from '../../core/provider/alerts/index.js';
import type { AlertLevel } from '../../core/provider/alerts/index.js';

export interface SlackAlertSinkOptions {
  /** Slack incoming webhook URL (built-in fetch, no SDK) */
  webhookUrl: string;
  /** optional channel override, e.g. '#ops' */
  channel?: string;
  /** optional sender name override */
  username?: string;
  /** request timeout in ms; defaults to 5000 */
  timeoutMs?: number;
  /** fetch implementation, injectable for tests; defaults to the global fetch */
  fetch?: FetchLike;
}

/**
 * Slack alert sink — posts the Slack incoming-webhook JSON payload
 * `{ text, channel?, username? }` via the built-in fetch. Delivery failures
 * throw; callers catch and continue.
 */
export function createSlackAlertSink(options: SlackAlertSinkOptions): AlertSink {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  return {
    async alert(level: AlertLevel, message: string, meta?: Record<string, unknown>) {
      const summary = meta === undefined ? message : `${message}\n\`\`\`${JSON.stringify(meta, null, 2)}\`\`\``;
      const text = `[${level.toUpperCase()}] ${summary}`;
      const payload: Record<string, unknown> = { text };
      if (options.channel !== undefined) payload.channel = options.channel;
      if (options.username !== undefined) payload.username = options.username;
      const res = await doFetch(options.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`slack alert failed: ${res.status} ${res.statusText}`);
      }
    },
  };
}

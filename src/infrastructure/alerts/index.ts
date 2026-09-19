import type { AlertSink, FetchLike } from '../../core/provider/alerts/index.js';
import { createConsoleAlertSink } from './console.js';
import { createSlackAlertSink } from './slack.js';
import { createWebhookAlertSink } from './webhook.js';

export { createConsoleAlertSink } from './console.js';
export { createSlackAlertSink } from './slack.js';
export { createWebhookAlertSink } from './webhook.js';
export type { SlackAlertSinkOptions } from './slack.js';
export type { WebhookAlertSinkOptions } from './webhook.js';

export const ALERT_CHANNELS = {
  CONSOLE: 'console',
  WEBHOOK: 'webhook',
  SLACK: 'slack',
} as const;
export type AlertChannel = typeof ALERT_CHANNELS[keyof typeof ALERT_CHANNELS];

/** factory config — channel-dependent fields are validated at call time */
export interface AlertsConfig {
  /** sink selection; defaults to 'console' */
  channel?: AlertChannel;
  /** webhook channel: target URL */
  url?: string;
  /** webhook channel: extra headers */
  headers?: Record<string, string>;
  /** shared request timeout in ms; defaults to 5000 */
  timeoutMs?: number;
  /** shared fetch implementation, injectable for tests */
  fetch?: FetchLike;
  /** slack channel: incoming webhook URL */
  webhookUrl?: string;
  /** slack channel: optional channel override */
  slackChannel?: string;
  /** slack channel: optional sender name */
  slackUsername?: string;
}

/** build an alert sink from config; defaults to the console sink */
export function createAlerts(config?: AlertsConfig): AlertSink {
  const channel = config?.channel ?? ALERT_CHANNELS.CONSOLE;
  switch (channel) {
    case ALERT_CHANNELS.WEBHOOK:
      if (config?.url === undefined) throw new Error('alerts config: webhook channel requires a url');
      return createWebhookAlertSink({ url: config.url, headers: config.headers, timeoutMs: config.timeoutMs, fetch: config.fetch });
    case ALERT_CHANNELS.SLACK:
      if (config?.webhookUrl === undefined) throw new Error('alerts config: slack channel requires a webhookUrl');
      return createSlackAlertSink({
        webhookUrl: config.webhookUrl,
        channel: config.slackChannel,
        username: config.slackUsername,
        timeoutMs: config.timeoutMs,
        fetch: config.fetch,
      });
    default:
      return createConsoleAlertSink();
  }
}

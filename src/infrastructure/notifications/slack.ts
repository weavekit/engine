import type {
  FetchLike,
  NotificationMessage,
  NotificationSink,
  SlackNotificationConfig,
} from '../../core/provider/notifications/index.js';
import { NOTIFICATION_SEVERITIES } from '../../core/provider/notifications/index.js';
import { postJson } from './http.js';

export interface SlackNotifierOptions extends SlackNotificationConfig {
  fetch?: FetchLike;
}

/** POST the Slack incoming-webhook payload (no SDK). */
export function createSlackNotifier(options: SlackNotifierOptions): NotificationSink {
  return {
    async send(message: NotificationMessage): Promise<void> {
      const severity = message.severity ?? NOTIFICATION_SEVERITIES.INFO;
      const subject = message.subject === undefined ? '' : `*${message.subject}*\n`;
      const text = `[${severity.toUpperCase()}] ${subject}${message.text}`;
      const payload: Record<string, unknown> = { text };
      if (options.channel !== undefined) payload.channel = options.channel;
      if (options.username !== undefined) payload.username = options.username;
      const response = await postJson(options.webhookUrl, payload, {
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      if (!response.ok) {
        throw new Error(`slack notification failed: ${response.status} ${response.statusText}`);
      }
    },
  };
}

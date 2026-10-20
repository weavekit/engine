import type {
  FetchLike,
  NotificationMessage,
  NotificationSink,
  WebhookNotificationConfig,
} from '../../core/provider/notifications/index.js';
import { NOTIFICATION_SEVERITIES } from '../../core/provider/notifications/index.js';
import { postJson } from './http.js';

export interface WebhookNotifierOptions extends WebhookNotificationConfig {
  fetch?: FetchLike;
}

/** POST a generic notification payload to an HTTP(S) endpoint. */
export function createWebhookNotifier(options: WebhookNotifierOptions): NotificationSink {
  return {
    async send(message: NotificationMessage): Promise<void> {
      const response = await postJson(
        options.url,
        {
          channel: message.channel,
          severity: message.severity ?? NOTIFICATION_SEVERITIES.INFO,
          subject: message.subject,
          text: message.text,
          html: message.html,
          meta: message.meta,
          ts: new Date().toISOString(),
        },
        {
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.headers === undefined ? {} : { headers: options.headers }),
        },
      );
      if (!response.ok) {
        throw new Error(`webhook notification failed: ${response.status} ${response.statusText}`);
      }
    },
  };
}

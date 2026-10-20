import type {
  FetchLike,
  NotificationMessage,
  NotificationSink,
  ResendNotificationConfig,
} from '../../core/provider/notifications/index.js';
import { postJson } from './http.js';

export interface ResendNotifierOptions extends ResendNotificationConfig {
  fetch?: FetchLike;
}

/** Send notifications through the Resend HTTPS API (no SDK). */
export function createResendNotifier(options: ResendNotifierOptions): NotificationSink {
  const endpoint = options.endpoint ?? 'https://api.resend.com/emails';
  return {
    async send(message: NotificationMessage): Promise<void> {
      if (message.to === undefined || message.to.length === 0) {
        throw new Error('resend notification requires at least one recipient');
      }
      const headers: Record<string, string> = {
        authorization: `Bearer ${options.apiKey}`,
      };
      if (message.idempotencyKey !== undefined) {
        headers['idempotency-key'] = message.idempotencyKey;
      }
      const response = await postJson(
        endpoint,
        {
          from: options.from,
          to: message.to,
          subject: message.subject ?? '(no subject)',
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
        },
        {
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          headers,
        },
      );
      if (!response.ok) {
        throw new Error(`resend notification failed: ${response.status} ${response.statusText}`);
      }
    },
  };
}

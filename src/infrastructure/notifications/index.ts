import type {
  NotificationChannel,
  NotificationSink,
  NotificationSinkConfig,
} from '../../core/provider/notifications/index.js';
import { NOTIFICATION_CHANNELS } from '../../core/provider/notifications/index.js';
import { createConsoleNotifier } from './console.js';
import { createFanoutNotifier, type NotificationSinkMap } from './fanout.js';
import { createWebhookNotifier } from './webhook.js';
import { createSlackNotifier } from './slack.js';
import { createSmtpNotifier } from './email-smtp.js';
import { createResendNotifier } from './email-resend.js';

export { createConsoleNotifier } from './console.js';
export { createFanoutNotifier } from './fanout.js';
export { createWebhookNotifier } from './webhook.js';
export { createSlackNotifier } from './slack.js';
export { createSmtpNotifier } from './email-smtp.js';
export { createResendNotifier } from './email-resend.js';
export type { NotificationSinkMap } from './fanout.js';
export type { WebhookNotifierOptions } from './webhook.js';
export type { SlackNotifierOptions } from './slack.js';
export type { SmtpNotifierOptions } from './email-smtp.js';
export type { ResendNotifierOptions } from './email-resend.js';

/** Build the transport sink from config; no channels = console. */
export function createNotificationSink(config: NotificationSinkConfig = {}): NotificationSink {
  const channels = config.channels ?? {};
  const sinks: NotificationSinkMap = {};
  if (channels.console === true) sinks[NOTIFICATION_CHANNELS.CONSOLE] = createConsoleNotifier();
  if (channels.webhook !== undefined) {
    sinks[NOTIFICATION_CHANNELS.WEBHOOK] = createWebhookNotifier({
      ...channels.webhook,
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    });
  }
  if (channels.slack !== undefined) {
    sinks[NOTIFICATION_CHANNELS.SLACK] = createSlackNotifier({
      ...channels.slack,
      ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    });
  }
  if (channels.email !== undefined) {
    const email = channels.email;
    const provider =
      email.provider ?? (email.smtp !== undefined ? 'smtp' : email.resend !== undefined ? 'resend' : undefined);
    if (provider === 'smtp') {
      if (email.smtp === undefined) throw new Error('email notifications: smtp config is required');
      sinks[NOTIFICATION_CHANNELS.EMAIL] = createSmtpNotifier({ ...email.smtp, from: email.from });
    } else if (provider === 'resend') {
      if (email.resend === undefined) throw new Error('email notifications: resend config is required');
      sinks[NOTIFICATION_CHANNELS.EMAIL] = createResendNotifier({
        ...email.resend,
        from: email.from,
        ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
      });
    } else {
      throw new Error('email notifications: choose provider "smtp" or "resend"');
    }
  }

  if (Object.keys(sinks).length === 0) sinks[NOTIFICATION_CHANNELS.CONSOLE] = createConsoleNotifier();
  const configured = Object.keys(sinks) as NotificationChannel[];
  return createFanoutNotifier(sinks, config.defaultChannel ?? configured[0]);
}

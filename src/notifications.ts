/**
 * Stable notification transport entry (`@weave-kit/engine/notifications`).
 *
 * Producers build a {@link NotificationMessage}; transports deliver it. This
 * entry never imports the engine runtime (no Fastify/pg) and contains no
 * approval/alert semantics.
 */
export {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_SEVERITIES,
} from './core/provider/notifications/index.js';
export type {
  EmailNotificationConfig,
  FetchLike,
  NotificationChannel,
  NotificationChannelsConfig,
  NotificationMessage,
  NotificationSeverity,
  NotificationSink,
  NotificationSinkConfig,
  ResendNotificationConfig,
  SlackNotificationConfig,
  SmtpNotificationConfig,
  WebhookNotificationConfig,
} from './core/provider/notifications/index.js';
export {
  createConsoleNotifier,
  createFanoutNotifier,
  createNotificationSink,
  createResendNotifier,
  createSlackNotifier,
  createSmtpNotifier,
  createWebhookNotifier,
} from './infrastructure/notifications/index.js';
export type {
  NotificationSinkMap,
  ResendNotifierOptions,
  SlackNotifierOptions,
  SmtpNotifierOptions,
  WebhookNotifierOptions,
} from './infrastructure/notifications/index.js';

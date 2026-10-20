/**
 * Notification transport contract — pure interfaces, zero dependencies.
 *
 * A **producer** (approval notifier, MCP guardrail alert, …) builds a
 * {@link NotificationMessage}; a **transport** (console/webhook/Slack/email)
 * only delivers it. Routing (which recipients, which channel, templates) stays
 * with the producer. Implementations live in `infrastructure/notifications` and
 * are exposed on the stable `@weave-kit/engine/notifications` entry.
 */

export const NOTIFICATION_CHANNELS = {
  CONSOLE: 'console',
  WEBHOOK: 'webhook',
  SLACK: 'slack',
  EMAIL: 'email',
} as const;
export type NotificationChannel = typeof NOTIFICATION_CHANNELS[keyof typeof NOTIFICATION_CHANNELS];

export const NOTIFICATION_SEVERITIES = {
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
} as const;
export type NotificationSeverity = typeof NOTIFICATION_SEVERITIES[keyof typeof NOTIFICATION_SEVERITIES];

/** one outbound message; `channel` absent = the sink's default/fan-out policy */
export interface NotificationMessage {
  channel?: NotificationChannel;
  /** email recipients; ignored by webhook/slack/console */
  to?: string[];
  subject?: string;
  text: string;
  html?: string;
  severity?: NotificationSeverity;
  /** producer correlation: kind/type/approvalKey/requestId/… */
  meta?: Record<string, unknown>;
  /** SMTP/Resend idempotency (outbox retry uses it) */
  idempotencyKey?: string;
}

/**
 * A delivery sink. Implementations must surface delivery failures as thrown
 * errors; the producer decides whether to retry or log. Delivery never mutates
 * the producer's state.
 */
export interface NotificationSink {
  send(message: NotificationMessage): Promise<void>;
}

/** Minimal injectable HTTP transport (same shape as fetch). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface WebhookNotificationConfig {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface SlackNotificationConfig {
  webhookUrl: string;
  channel?: string;
  username?: string;
  timeoutMs?: number;
}

export interface SmtpNotificationConfig {
  host: string;
  port?: number;
  secure?: boolean;
  auth?: { user: string; pass: string };
  tls?: Record<string, unknown>;
  from: string;
  replyTo?: string;
  timeoutMs?: number;
}

export interface ResendNotificationConfig {
  apiKey: string;
  from: string;
  endpoint?: string;
  timeoutMs?: number;
}

export interface EmailNotificationConfig {
  provider?: 'smtp' | 'resend';
  from: string;
  smtp?: Omit<SmtpNotificationConfig, 'from'>;
  resend?: Omit<ResendNotificationConfig, 'from'>;
}

export interface NotificationChannelsConfig {
  console?: boolean;
  webhook?: WebhookNotificationConfig;
  slack?: SlackNotificationConfig;
  email?: EmailNotificationConfig;
}

export interface NotificationSinkConfig {
  channels?: NotificationChannelsConfig;
  /** channel used when a producer omits `message.channel` (default: first configured) */
  defaultChannel?: NotificationChannel;
  fetch?: FetchLike;
}


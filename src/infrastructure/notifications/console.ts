import type {
  NotificationMessage,
  NotificationSeverity,
  NotificationSink,
} from '../../core/provider/notifications/index.js';
import { NOTIFICATION_SEVERITIES } from '../../core/provider/notifications/index.js';

function line(message: NotificationMessage): string {
  const meta = message.meta === undefined ? '' : ` ${JSON.stringify(message.meta)}`;
  return `[weavekit:notify:${message.severity ?? NOTIFICATION_SEVERITIES.INFO}] ${message.text}${meta}`;
}

/** Write notifications to the console by severity. */
export function createConsoleNotifier(): NotificationSink {
  return {
    async send(message: NotificationMessage): Promise<void> {
      const severity: NotificationSeverity = message.severity ?? NOTIFICATION_SEVERITIES.INFO;
      if (severity === NOTIFICATION_SEVERITIES.ERROR) console.error(line(message));
      else if (severity === NOTIFICATION_SEVERITIES.WARN) console.warn(line(message));
      else console.info(line(message));
    },
  };
}

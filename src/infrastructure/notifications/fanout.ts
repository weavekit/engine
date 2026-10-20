import type {
  NotificationChannel,
  NotificationMessage,
  NotificationSink,
} from '../../core/provider/notifications/index.js';

export type NotificationSinkMap = Partial<Record<NotificationChannel, NotificationSink>>;

/**
 * Route by `message.channel`; when omitted, send to every configured channel.
 * A failing channel does not prevent the others from receiving the message.
 */
export function createFanoutNotifier(
  sinks: NotificationSinkMap,
  defaultChannel?: NotificationChannel,
): NotificationSink {
  const entries = Object.entries(sinks).filter((entry): entry is [NotificationChannel, NotificationSink] =>
    entry[1] !== undefined,
  );
  if (entries.length === 0) throw new Error('notification fanout requires at least one channel');

  return {
    channels: entries.map(([channel]) => channel),
    async send(message: NotificationMessage): Promise<void> {
      const channel = message.channel ?? defaultChannel;
      const targets = channel === undefined ? entries : entries.filter(([name]) => name === channel);
      if (targets.length === 0) {
        throw new Error(`notification channel "${channel}" is not configured`);
      }
      const results = await Promise.allSettled(targets.map(([, sink]) => sink.send(message)));
      const failure = results.find((result) => result.status === 'rejected');
      if (failure !== undefined && failure.status === 'rejected') throw failure.reason;
    },
  };
}

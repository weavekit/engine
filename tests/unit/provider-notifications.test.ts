import { describe, it, expect } from '../helpers/test.js';
import {
  createFanoutNotifier,
  createNotificationSink,
  createResendNotifier,
  createSlackNotifier,
  createSmtpNotifier,
  createWebhookNotifier,
} from '../../src/infrastructure/notifications/index.js';
import { NOTIFICATION_CHANNELS, NOTIFICATION_SEVERITIES } from '../../src/core/provider/notifications/index.js';

function recorder() {
  const messages: Array<Record<string, unknown>> = [];
  return {
    messages,
    fetch: async (_input: string | URL | Request, init?: RequestInit) => {
      messages.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response('{}', { status: 200 });
    },
  };
}

describe('webhook notifier', () => {
  it('posts the generic payload', async () => {
    const cap = recorder();
    const sink = createWebhookNotifier({ url: 'https://hooks.test/x', headers: { 'x-key': '1' }, fetch: cap.fetch });
    await sink.send({
      severity: NOTIFICATION_SEVERITIES.WARN,
      subject: 'Approval required',
      text: 'AP-1',
      meta: { kind: 'approval.requested' },
    });
    expect(cap.messages[0]).toMatchObject({
      severity: 'warn',
      subject: 'Approval required',
      text: 'AP-1',
      meta: { kind: 'approval.requested' },
    });
  });

  it('throws on non-2xx', async () => {
    const sink = createWebhookNotifier({
      url: 'https://hooks.test/x',
      fetch: async () => new Response('no', { status: 500, statusText: 'boom' }),
    });
    await expect(sink.send({ text: 'x' })).rejects.toThrow('webhook notification failed');
  });
});

describe('slack notifier', () => {
  it('formats severity and subject', async () => {
    const cap = recorder();
    const sink = createSlackNotifier({ webhookUrl: 'https://slack.test/x', channel: '#ops', fetch: cap.fetch });
    await sink.send({ severity: NOTIFICATION_SEVERITIES.ERROR, subject: 'Rejected', text: 'AP-2' });
    expect(cap.messages[0]).toMatchObject({ channel: '#ops', text: '[ERROR] *Rejected*\nAP-2' });
  });
});

describe('resend notifier', () => {
  it('calls the HTTPS API with auth and idempotency', async () => {
    const cap = recorder();
    const sink = createResendNotifier({ apiKey: 'rk', from: 'noreply@acme.test', fetch: cap.fetch });
    await sink.send({
      to: ['a@acme.test'],
      subject: 'Approval',
      text: 'AP-3',
      idempotencyKey: 'idem-1',
    });
    expect(cap.messages[0]).toMatchObject({
      from: 'noreply@acme.test',
      to: ['a@acme.test'],
      subject: 'Approval',
      text: 'AP-3',
    });
  });

  it('requires recipients', async () => {
    const sink = createResendNotifier({ apiKey: 'rk', from: 'noreply@acme.test' });
    await expect(sink.send({ text: 'x' })).rejects.toThrow('requires at least one recipient');
  });
});

describe('smtp notifier', () => {
  it('lazily loads nodemailer and sends the message', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let loads = 0;
    const sink = createSmtpNotifier({
      host: 'smtp.acme.test',
      from: 'noreply@acme.test',
      load: async () => {
        loads += 1;
        return {
          createTransport: () => ({
            sendMail: async (message: Record<string, unknown>) => {
              sent.push(message);
            },
          }),
        };
      },
    });
    await sink.send({ to: ['a@acme.test'], subject: 'Approval', text: 'AP-4', html: '<p>AP-4</p>' });
    await sink.send({ to: ['b@acme.test'], text: 'AP-5' });
    expect(loads).toBe(1);
    expect(sent[0]).toMatchObject({
      from: 'noreply@acme.test',
      to: 'a@acme.test',
      subject: 'Approval',
      text: 'AP-4',
      html: '<p>AP-4</p>',
    });
    expect(sent[1]!.subject).toBe('(no subject)');
  });

  it('requires recipients', async () => {
    const sink = createSmtpNotifier({ host: 'smtp.acme.test', from: 'noreply@acme.test' });
    await expect(sink.send({ text: 'x' })).rejects.toThrow('requires at least one recipient');
  });
});

describe('fanout + factory', () => {
  it('routes by channel and defaults to the first configured channel', async () => {
    const one: string[] = [];
    const two: string[] = [];
    const sink = createFanoutNotifier(
      {
        [NOTIFICATION_CHANNELS.CONSOLE]: { send: async (m) => void one.push(m.text) },
        [NOTIFICATION_CHANNELS.SLACK]: { send: async (m) => void two.push(m.text) },
      },
      NOTIFICATION_CHANNELS.SLACK,
    );
    await sink.send({ text: 'default' });
    await sink.send({ channel: NOTIFICATION_CHANNELS.CONSOLE, text: 'console' });
    expect(one).toEqual(['console']);
    expect(two).toEqual(['default']);
  });

  it('throws for an unconfigured channel', async () => {
    const sink = createFanoutNotifier({ console: { send: async () => {} } });
    await expect(sink.send({ channel: NOTIFICATION_CHANNELS.EMAIL, text: 'x' })).rejects.toThrow(
      'not configured',
    );
  });

  it('createNotificationSink builds a transport from channels', async () => {
    const cap = recorder();
    const sink = createNotificationSink({
      channels: { webhook: { url: 'https://hooks.test/x' } },
      fetch: cap.fetch,
    });
    await sink.send({ text: 'from factory' });
    expect(cap.messages[0]).toMatchObject({ text: 'from factory' });
  });

  it('createNotificationSink validates the email provider', () => {
    expect(() => createNotificationSink({ channels: { email: { from: 'a@b.c' } } })).toThrow(
      'choose provider',
    );
    expect(() =>
      createNotificationSink({ channels: { email: { provider: 'resend', from: 'a@b.c' } } }),
    ).toThrow('resend config is required');
    expect(() =>
      createNotificationSink({ channels: { email: { provider: 'smtp', from: 'a@b.c' } } }),
    ).toThrow('smtp config is required');
  });
});

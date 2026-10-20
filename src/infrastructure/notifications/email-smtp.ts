import type {
  NotificationMessage,
  NotificationSink,
  SmtpNotificationConfig,
} from '../../core/provider/notifications/index.js';

interface SmtpTransport {
  sendMail(message: Record<string, unknown>): Promise<unknown>;
}

interface NodemailerModule {
  createTransport(options: Record<string, unknown>): SmtpTransport;
}

export interface SmtpNotifierOptions extends SmtpNotificationConfig {
  /** injectable loader (tests); defaults to the optional `nodemailer` package */
  load?: () => Promise<NodemailerModule>;
}

async function defaultLoad(): Promise<NodemailerModule> {
  try {
    const specifier = 'nodemailer';
    const mod = (await import(specifier)) as NodemailerModule & { default?: NodemailerModule };
    const mailer = mod.default ?? mod;
    if (typeof mailer.createTransport !== 'function') throw new Error('invalid nodemailer module');
    return mailer;
  } catch {
    throw new Error(
      'SMTP notifications require the optional "nodemailer" package; install it in the engine host',
    );
  }
}

/** Send notifications over SMTP via the optional `nodemailer` package. */
export function createSmtpNotifier(options: SmtpNotifierOptions): NotificationSink {
  let transporter: SmtpTransport | undefined;
  const load = options.load ?? defaultLoad;

  async function transport(): Promise<SmtpTransport> {
    if (transporter !== undefined) return transporter;
    const mailer = await load();
    transporter = mailer.createTransport({
      host: options.host,
      port: options.port ?? 587,
      secure: options.secure ?? false,
      ...(options.auth === undefined ? {} : { auth: options.auth }),
      ...(options.tls === undefined ? {} : { tls: options.tls }),
      ...(options.timeoutMs === undefined ? {} : { connectionTimeout: options.timeoutMs }),
    });
    return transporter;
  }

  return {
    async send(message: NotificationMessage): Promise<void> {
      if (message.to === undefined || message.to.length === 0) {
        throw new Error('smtp notification requires at least one recipient');
      }
      const mail = await transport();
      await mail.sendMail({
        from: options.from,
        to: message.to.join(', '),
        subject: message.subject ?? '(no subject)',
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
        ...(options.replyTo === undefined ? {} : { replyTo: options.replyTo }),
        ...(message.idempotencyKey === undefined
          ? {}
          : { headers: { 'X-WeaveKit-Idempotency-Key': message.idempotencyKey } }),
      });
    },
  };
}

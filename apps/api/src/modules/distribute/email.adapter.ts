// The email output (GWP#6, D-041, docs/outputs.md): one plain-text message per completed item, from the
// installation's sender (EMAIL_FROM) to the output's own recipients, at most 20. The transport is chosen
// by EMAIL_TRANSPORT: `ses` (Amazon SES SendEmail; in sandbox mode SES rejects an unverified recipient,
// which is final), `smtp` (SMTP_URL, for other installers) or `memory` (tests only). Without one, email
// outputs fail with `email_not_configured`.
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { EmailConfig } from '@getworkdone/contracts';
import { withSpan } from '@getworkdone/telemetry';
import nodemailer from 'nodemailer';
import { deadline } from './deadline.js';
import type { CompletedItem, DeliveryContext, DeliveryResult, OutputAdapter } from './output-adapter.js';

export interface EmailMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
}

/** Sends one message and names the outcome; never throws for a failed send. */
export interface EmailTransport {
  send(message: EmailMessage, signal: AbortSignal): Promise<DeliveryResult>;
}

const TIMEOUT: DeliveryResult = { status: 'retryable', reason: 'timeout' };
const THROTTLED = new Set(['TooManyRequestsException', 'ThrottlingException', 'LimitExceededException']);

/** The part of SESv2Client the transport uses, so a test can stub it. */
export interface SesClientLike {
  send(command: SendEmailCommand, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

/** An SES error as an outcome. An unverified recipient (sandbox mode, D-041) is never retried. */
function sesOutcome(error: unknown, signal: AbortSignal): DeliveryResult {
  const { name, message, $metadata } = (error ?? {}) as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  if (signal.aborted || name === 'AbortError') return TIMEOUT;
  if (name === 'MessageRejected') return { status: 'failed', reason: /not verified/i.test(message ?? '') ? 'recipient_not_verified' : 'message_rejected' };
  if (name && THROTTLED.has(name)) return { status: 'retryable', reason: 'throttled' };
  // No HTTP status: the request never got an answer.
  if ($metadata?.httpStatusCode === undefined) return { status: 'retryable', reason: 'network_error' };
  return { status: $metadata.httpStatusCode >= 500 ? 'retryable' : 'failed', reason: `ses_${name ?? 'error'}` };
}

/** Amazon SES (`@aws-sdk/client-sesv2` SendEmail). The client makes one attempt; the worker retries. */
export class SesEmailTransport implements EmailTransport {
  constructor(private readonly client: SesClientLike) {}

  async send(message: EmailMessage, signal: AbortSignal): Promise<DeliveryResult> {
    const command = new SendEmailCommand({
      FromEmailAddress: message.from,
      Destination: { ToAddresses: message.to },
      Content: { Simple: { Subject: { Data: message.subject, Charset: 'UTF-8' }, Body: { Text: { Data: message.text, Charset: 'UTF-8' } } } },
    });
    try {
      await this.client.send(command, { abortSignal: signal });
      return { status: 'delivered' };
    } catch (error) {
      return sesOutcome(error, signal);
    }
  }
}

/** The part of a nodemailer transporter the transport uses. */
export interface SmtpTransporterLike {
  sendMail(message: EmailMessage): Promise<unknown>;
}

/** SMTP through nodemailer, for installers without SES. A 4xx reply is retried, a 5xx reply is final. */
export class SmtpEmailTransport implements EmailTransport {
  constructor(private readonly transporter: SmtpTransporterLike) {}

  async send(message: EmailMessage, signal: AbortSignal): Promise<DeliveryResult> {
    if (signal.aborted) return TIMEOUT;
    // nodemailer takes no signal: at the deadline the attempt is given up, and the message may still go.
    const aborted = new Promise<DeliveryResult>((resolve) => signal.addEventListener('abort', () => resolve(TIMEOUT), { once: true }));
    const sent = this.transporter.sendMail({ from: message.from, to: message.to, subject: message.subject, text: message.text }).then(
      (): DeliveryResult => ({ status: 'delivered' }),
      (error: unknown): DeliveryResult => {
        const code = (error as { responseCode?: unknown } | null)?.responseCode;
        if (typeof code !== 'number') return { status: 'retryable', reason: 'network_error' };
        return { status: code >= 500 ? 'failed' : 'retryable', reason: `smtp_${code}` };
      },
    );
    return Promise.race([sent, aborted]);
  }
}

/** Keeps what it is given; for tests, and refused outside them (emailTransportFromEnv). */
export class MemoryEmailTransport implements EmailTransport {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<DeliveryResult> {
    this.sent.push(message);
    return { status: 'delivered' };
  }
}

/** The transport EMAIL_TRANSPORT names, or none when it is unset. Throws on a setting that cannot work. */
export function emailTransportFromEnv(env: NodeJS.ProcessEnv): EmailTransport | undefined {
  switch (env.EMAIL_TRANSPORT || undefined) {
    case undefined:
      return undefined;
    case 'ses':
      return new SesEmailTransport(new SESv2Client({ maxAttempts: 1, ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}) }) as SesClientLike);
    case 'smtp':
      if (!env.SMTP_URL) throw new Error('EMAIL_TRANSPORT=smtp needs SMTP_URL');
      return new SmtpEmailTransport(nodemailer.createTransport(env.SMTP_URL));
    case 'memory':
      if (env.NODE_ENV !== 'test') throw new Error('EMAIL_TRANSPORT=memory is only for tests: it sends nothing');
      return new MemoryEmailTransport();
    default:
      throw new Error('EMAIL_TRANSPORT must be ses, smtp or memory');
  }
}

/** The message body: when the item completed, each field's label and value in field order, the item id. */
export function emailText(item: CompletedItem): string {
  const lines = item.workType.fields.map((field) => {
    const value = item.data[field.key];
    return `${field.label}: ${value === undefined || value === null ? '' : String(value)}`;
  });
  return [`A ${item.workType.slug} item was completed at ${item.completedAt}.`, '', ...lines, '', `Item: ${item.id}`].join('\n');
}

export class EmailAdapter implements OutputAdapter {
  readonly kind = 'email' as const;

  constructor(private readonly transport: EmailTransport | undefined, private readonly from: string | undefined) {}

  async deliver(item: CompletedItem, config: unknown, ctx: DeliveryContext): Promise<DeliveryResult> {
    const parsed = EmailConfig.safeParse(config);
    if (!parsed.success) return { status: 'failed', reason: 'invalid_config' };
    const { transport, from } = this;
    if (!transport || !from) return { status: 'failed', reason: 'email_not_configured' };
    const subject = (parsed.data.subject ?? `${item.workType.slug}: item completed`).replace(/[\r\n]/g, ' ');
    const { signal, clear } = deadline(ctx.deadlineMs, ctx.signal);
    try {
      return await withSpan('distribute.email.send', async (span) => {
        span.setAttribute('email.recipients', parsed.data.recipients.length);
        return transport.send({ from, to: parsed.data.recipients, subject, text: emailText(item) }, signal);
      });
    } finally {
      clear();
    }
  }
}

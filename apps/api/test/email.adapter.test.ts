import { MessageRejected, SendEmailCommand, TooManyRequestsException } from '@aws-sdk/client-sesv2';
import { describe, expect, it, vi } from 'vitest';
import { EmailAdapter, emailTransportFromEnv, MemoryEmailTransport, SesEmailTransport, SmtpEmailTransport, type EmailMessage } from '../src/modules/distribute/email.adapter.js';
import type { CompletedItem, DeliveryContext } from '../src/modules/distribute/output-adapter.js';

// The email output (GWP#6, D-041, docs/outputs.md): one message from the configured sender to the
// output's own recipients, through EMAIL_TRANSPORT (ses, smtp or memory). SES in sandbox mode rejects
// an unverified recipient; that is final (`recipient_not_verified`), throttling is retried.
const item: CompletedItem = {
  id: 'item-1', teamId: 'team-1', workTypeVersionId: 'wtv-1', data: { title: 'Fix the door', qty: 2, note: 'line one\nline two' },
  createdAt: '2026-10-21T10:00:00.000Z', completedAt: '2026-10-21T11:00:00.000Z',
  workType: {
    id: 'wt-1', slug: 'repairs', version: 3,
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'qty', label: 'Quantity', type: 'number', required: false },
      { key: 'note', label: 'Note', type: 'longtext', required: false },
      { key: 'empty', label: 'Empty', type: 'text', required: false },
    ],
  },
};
const ctx: DeliveryContext = { idempotencyKey: 'item-1:mail', deadlineMs: 10_000, signal: new AbortController().signal };
const config = { recipients: ['ops@example.com', 'lead@example.com'] };
const FROM = 'GetWorkDone <noreply@example.com>';

const metadata = { $metadata: { httpStatusCode: 400 } };

/** An SES client stub: records each command and answers with `answer`. */
function sesStub(answer: () => Promise<unknown> = async () => ({ MessageId: 'm-1' })) {
  const send = vi.fn(async (command: SendEmailCommand, _options?: { abortSignal?: AbortSignal }) => {
    void command;
    return answer();
  });
  return { client: { send }, send };
}

describe('EmailAdapter with SES', () => {
  it('a send uses the configured sender and only the output\'s recipients', async () => {
    const { client, send } = sesStub();
    const adapter = new EmailAdapter(new SesEmailTransport(client), FROM);
    expect(await adapter.deliver(item, config, ctx)).toEqual({ status: 'delivered' });
    expect(send).toHaveBeenCalledTimes(1);
    const [command, options] = send.mock.calls[0]!;
    expect(command).toBeInstanceOf(SendEmailCommand);
    expect(command.input.FromEmailAddress).toBe(FROM);
    expect(command.input.Destination).toEqual({ ToAddresses: ['ops@example.com', 'lead@example.com'] });
    expect(command.input.Content?.Simple?.Subject?.Data).toBe('repairs: item completed');
    expect(command.input.Content?.Simple?.Body?.Text?.Data).toBe([
      'A repairs item was completed at 2026-10-21T11:00:00.000Z.',
      '',
      'Title: Fix the door',
      'Quantity: 2',
      'Note: line one\nline two',
      'Empty: ',
      '',
      'Item: item-1',
    ].join('\n'));
    expect(options?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('an SES MessageRejected for an unverified address ends failed with recipient_not_verified after one attempt', async () => {
    const { client, send } = sesStub(() => Promise.reject(new MessageRejected({ message: 'Email address is not verified. The following identities failed the check in region US-EAST-1: ops@example.com', ...metadata })));
    const adapter = new EmailAdapter(new SesEmailTransport(client), FROM);
    expect(await adapter.deliver(item, config, ctx)).toEqual({ status: 'failed', reason: 'recipient_not_verified' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('another MessageRejected is failed with its own reason', async () => {
    const { client } = sesStub(() => Promise.reject(new MessageRejected({ message: 'Illegal address', ...metadata })));
    expect(await new EmailAdapter(new SesEmailTransport(client), FROM).deliver(item, config, ctx)).toEqual({ status: 'failed', reason: 'message_rejected' });
  });

  it('a throttling error is retryable', async () => {
    const { client } = sesStub(() => Promise.reject(new TooManyRequestsException({ message: 'Too many requests', $metadata: { httpStatusCode: 429 } })));
    expect(await new EmailAdapter(new SesEmailTransport(client), FROM).deliver(item, config, ctx)).toEqual({ status: 'retryable', reason: 'throttled' });
  });

  it('a server error or a lost connection is retryable; a timeout is retryable; any other client error is failed', async () => {
    const answer = (error: unknown) => new EmailAdapter(new SesEmailTransport(sesStub(() => Promise.reject(error)).client), FROM).deliver(item, config, ctx);
    expect(await answer(Object.assign(new Error('boom'), { name: 'InternalFailure', $metadata: { httpStatusCode: 500 } }))).toEqual({ status: 'retryable', reason: 'ses_InternalFailure' });
    expect(await answer(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toEqual({ status: 'retryable', reason: 'network_error' });
    expect(await answer(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toEqual({ status: 'retryable', reason: 'timeout' });
    expect(await answer(Object.assign(new Error('nope'), { name: 'AccountSuspendedException', $metadata: { httpStatusCode: 400 } }))).toEqual({ status: 'failed', reason: 'ses_AccountSuspendedException' });
  });
});

describe('EmailAdapter', () => {
  it('uses the output\'s subject, without line breaks', async () => {
    const transport = new MemoryEmailTransport();
    await new EmailAdapter(transport, FROM).deliver(item, { ...config, subject: 'Done\r\nBcc: x@example.com' }, ctx);
    expect(transport.sent[0]?.subject).toBe('Done  Bcc: x@example.com');
  });

  it('a config that does not parse, or more than 20 recipients, is failed without sending', async () => {
    const transport = new MemoryEmailTransport();
    const adapter = new EmailAdapter(transport, FROM);
    const many = Array.from({ length: 21 }, (_, i) => `r${i}@example.com`);
    expect(await adapter.deliver(item, { recipients: many }, ctx)).toEqual({ status: 'failed', reason: 'invalid_config' });
    expect(await adapter.deliver(item, null, ctx)).toEqual({ status: 'failed', reason: 'invalid_config' });
    expect(transport.sent).toEqual([]);
  });

  it('without a transport or a sender, email is not configured', async () => {
    expect(await new EmailAdapter(undefined, FROM).deliver(item, config, ctx)).toEqual({ status: 'failed', reason: 'email_not_configured' });
    expect(await new EmailAdapter(new MemoryEmailTransport(), undefined).deliver(item, config, ctx)).toEqual({ status: 'failed', reason: 'email_not_configured' });
    expect(new EmailAdapter(undefined, undefined).kind).toBe('email');
  });
});

describe('SmtpEmailTransport', () => {
  const message: EmailMessage = { from: FROM, to: ['ops@example.com'], subject: 's', text: 't' };

  it('sends one message with nodemailer', async () => {
    const sendMail = vi.fn(async () => ({ messageId: 'x' }));
    expect(await new SmtpEmailTransport({ sendMail }).send(message, ctx.signal)).toEqual({ status: 'delivered' });
    expect(sendMail).toHaveBeenCalledWith({ from: FROM, to: ['ops@example.com'], subject: 's', text: 't' });
  });

  it('a 4xx reply or a lost connection is retryable, a 5xx reply is failed', async () => {
    const reply = (error: unknown) => new SmtpEmailTransport({ sendMail: () => Promise.reject(error) }).send(message, ctx.signal);
    expect(await reply(Object.assign(new Error('try later'), { responseCode: 451 }))).toEqual({ status: 'retryable', reason: 'smtp_451' });
    expect(await reply(Object.assign(new Error('no such user'), { responseCode: 550 }))).toEqual({ status: 'failed', reason: 'smtp_550' });
    expect(await reply(Object.assign(new Error('connection refused'), { code: 'ECONNECTION' }))).toEqual({ status: 'retryable', reason: 'network_error' });
  });

  it('gives up at the deadline', async () => {
    const controller = new AbortController();
    const pending = new SmtpEmailTransport({ sendMail: () => new Promise(() => {}) }).send(message, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ status: 'retryable', reason: 'timeout' });
    const aborted = new AbortController();
    aborted.abort();
    expect(await new SmtpEmailTransport({ sendMail: vi.fn() }).send(message, aborted.signal)).toEqual({ status: 'retryable', reason: 'timeout' });
  });
});

describe('emailTransportFromEnv', () => {
  it('chooses ses, smtp or memory from EMAIL_TRANSPORT, and none when unset', () => {
    expect(emailTransportFromEnv({ EMAIL_TRANSPORT: 'ses', AWS_REGION: 'us-east-1' })).toBeInstanceOf(SesEmailTransport);
    expect(emailTransportFromEnv({ EMAIL_TRANSPORT: 'smtp', SMTP_URL: 'smtp://mail.example.com:587' })).toBeInstanceOf(SmtpEmailTransport);
    expect(emailTransportFromEnv({ EMAIL_TRANSPORT: 'memory', NODE_ENV: 'test' })).toBeInstanceOf(MemoryEmailTransport);
    expect(emailTransportFromEnv({})).toBeUndefined();
  });

  it('refuses the memory transport outside tests, smtp without SMTP_URL, and an unknown name', () => {
    expect(() => emailTransportFromEnv({ EMAIL_TRANSPORT: 'memory', NODE_ENV: 'production' })).toThrow('EMAIL_TRANSPORT=memory is only for tests');
    expect(() => emailTransportFromEnv({ EMAIL_TRANSPORT: 'smtp' })).toThrow('EMAIL_TRANSPORT=smtp needs SMTP_URL');
    expect(() => emailTransportFromEnv({ EMAIL_TRANSPORT: 'pigeon' })).toThrow('EMAIL_TRANSPORT must be ses, smtp or memory');
  });
});

// The webhook output (GWP#6, docs/outputs.md): a signed JSON POST to the output's https URL. Webhooks are
// the app's first user-configured outbound calls, so each send is bounded: a deadline per attempt, no
// redirects, and never to a private, loopback, link-local or metadata address (blocked-address.ts),
// checked for every address the host resolves to, when it is sent to. The check runs twice: once before
// the POST, for a clear reason, and again inside the HTTP client's own connect, so the address dialled
// is one that was checked and a name whose answer changes in between (DNS rebinding) is still refused.
// The POST runs inside withSpan (scripts/instrument-lint.ts).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { WebhookConfig } from '@getworkdone/contracts';
import { withSpan } from '@getworkdone/telemetry';
import { Agent, fetch } from 'undici';
import { z } from 'zod';
import { isBlockedAddress } from './blocked-address.js';
import { deadline } from './deadline.js';
import type { CompletedItem, DeliveryContext, DeliveryResult, OutputAdapter } from './output-adapter.js';

/** Resolves a host name to every address it has, as dns.promises.lookup with `all` does. */
export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

/** The HTTP client's shape, as the adapter calls it. */
export type FetchLike = (url: URL, init: RequestInit) => Promise<Response>;

export interface WebhookAdapterOptions {
  /** The HTTP client; undici's fetch through the adapter's checking Agent unless a test hands in its own. */
  fetch?: FetchLike;
  /** The resolver; the system's unless a test hands in its own. */
  lookup?: LookupFn;
}

/** What the worker passes: the stored config plus the output's secret (OutputSecret). */
const RuntimeConfig = WebhookConfig.extend({ secret: z.string().min(1) });

const systemLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** The code of the error the connect-time lookup fails with for a blocked address. */
const BLOCKED = 'EGWDBLOCKEDADDRESS';

/** True when `error`, or any error it was caused by, is the connect-time lookup's refusal. */
function isBlockedError(error: unknown): boolean {
  for (let e = error; e instanceof Error || (typeof e === 'object' && e !== null); e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === BLOCKED) return true;
  }
  return false;
}

/** `sha256=<hex HMAC-SHA256 of body>`, the X-GetWorkDone-Signature header's value. */
export function signBody(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** What a receiver runs: true when `header` is the signature of exactly `body` under `secret`. */
export function verifySignature(secret: string, body: string, header: string): boolean {
  const expected = Buffer.from(signBody(secret, body));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The POST body: the item without its work type's field list, the work type, and when it completed. */
export function webhookBody(item: CompletedItem): string {
  const { id, teamId, workTypeVersionId, data, createdAt } = item;
  return JSON.stringify({ item: { id, teamId, workTypeVersionId, data, createdAt }, workType: { id: item.workType.id, slug: item.workType.slug, version: item.workType.version }, completedAt: item.completedAt });
}

function isHttpUrl(config: unknown): boolean {
  const url = (config as { url?: unknown } | null)?.url;
  try {
    return typeof url === 'string' && new URL(url).protocol === 'http:';
  } catch {
    return false;
  }
}

/** The response status as an outcome: 2xx delivered; 408, 425, 429 and 5xx may pass; a redirect or other 4xx will not. */
function outcome(status: number): DeliveryResult {
  if (status >= 200 && status < 300) return { status: 'delivered' };
  if (status >= 300 && status < 400) return { status: 'failed', reason: 'redirect_not_followed' };
  if (status >= 500 || status === 408 || status === 425 || status === 429) return { status: 'retryable', reason: `http_${status}` };
  return { status: 'failed', reason: `http_${status}` };
}

/** `promise`, or a rejection as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export class WebhookAdapter implements OutputAdapter {
  readonly kind = 'webhook' as const;

  /** Resolves through `lookup` when connecting and refuses a blocked address, so the dialled address is a checked one. */
  private readonly agent: Agent;

  constructor(private readonly options: WebhookAdapterOptions = {}) {
    const resolve = options.lookup ?? systemLookup;
    const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
      resolve(hostname).then((answers) => {
        if (answers.length === 0) throw Object.assign(new Error(`${hostname} has no address`), { code: 'ENOTFOUND' });
        if (answers.some((a) => isBlockedAddress(a.address))) throw Object.assign(new Error(`${hostname} resolves to a blocked address`), { code: BLOCKED });
        const [first] = answers as [{ address: string; family: number }];
        if (lookupOptions.all) (callback as unknown as (err: null, all: { address: string; family: number }[]) => void)(null, answers);
        else callback(null, first.address, first.family);
      }).catch((error: NodeJS.ErrnoException) => callback(error, '', 0));
    };
    this.agent = new Agent({ connect: { lookup } as object });
  }

  async deliver(item: CompletedItem, config: unknown, ctx: DeliveryContext): Promise<DeliveryResult> {
    const parsed = RuntimeConfig.safeParse(config);
    if (!parsed.success) return { status: 'failed', reason: isHttpUrl(config) ? 'https_required' : 'invalid_config' };
    const url = new URL(parsed.data.url);
    const body = webhookBody(item);
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'GetWorkDone-Webhook/1',
      'idempotency-key': ctx.idempotencyKey,
      'x-getworkdone-signature': signBody(parsed.data.secret, body),
    };
    // The worker's signal, and this attempt's own deadline in case the caller's is longer.
    const { signal, clear } = deadline(ctx.deadlineMs, ctx.signal);
    try {
      return await this.post(url, headers, body, signal);
    } finally {
      clear();
    }
  }

  private post(url: URL, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<DeliveryResult> {
    return withSpan('distribute.webhook.request', async (span) => {
      span.setAttributes({ 'http.request.method': 'POST', 'server.address': url.hostname });
      const refused = await this.checkAddresses(url.hostname, signal);
      if (refused) return refused;
      const init: RequestInit = { method: 'POST', headers, body, redirect: 'manual', signal };
      let response: Response;
      try {
        response = await (this.options.fetch ? this.options.fetch(url, init) : (fetch(url, { ...init, dispatcher: this.agent } as Parameters<typeof fetch>[1]) as unknown as Promise<Response>));
      } catch (error) {
        if (isBlockedError(error)) return { status: 'failed', reason: 'blocked_address' };
        return signal.aborted ? { status: 'retryable', reason: 'timeout' } : { status: 'retryable', reason: 'network_error' };
      }
      span.setAttribute('http.response.status_code', response.status);
      // The receiver's answer is never read: only its status counts.
      await response.body?.cancel().catch(() => undefined);
      return outcome(response.status);
    });
  }

  /**
   * Undefined when every address `hostname` stands for may be sent to; otherwise why not. An IP literal
   * is checked as it is; a name is resolved and each of its addresses checked.
   */
  private async checkAddresses(hostname: string, signal: AbortSignal): Promise<DeliveryResult | undefined> {
    const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
    let addresses: string[];
    if (isIP(host) !== 0) {
      addresses = [host];
    } else {
      try {
        addresses = (await untilAborted((this.options.lookup ?? systemLookup)(host), signal)).map((a) => a.address);
      } catch {
        return signal.aborted ? { status: 'retryable', reason: 'timeout' } : { status: 'retryable', reason: 'dns_error' };
      }
    }
    if (addresses.length === 0) return { status: 'retryable', reason: 'dns_error' };
    return addresses.some(isBlockedAddress) ? { status: 'failed', reason: 'blocked_address' } : undefined;
  }
}

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompletedItem, DeliveryContext } from '../src/modules/distribute/output-adapter.js';
import { isBlockedAddress } from '../src/modules/distribute/blocked-address.js';
import { signBody, verifySignature, WebhookAdapter } from '../src/modules/distribute/webhook.adapter.js';
import { publicLookup, startReceiver, type Receiver } from './support/receiver.js';

// The webhook output (GWP#6, docs/outputs.md): a signed JSON POST with the delivery's Idempotency-Key,
// within a deadline, never to a private, loopback, link-local or metadata address, never following a
// redirect. The receiver is real HTTP on loopback (support/receiver.ts).
const item: CompletedItem = {
  id: 'item-1', teamId: 'team-1', workTypeVersionId: 'wtv-1', data: { title: 'Fix the door', qty: 2 },
  createdAt: '2026-10-21T10:00:00.000Z', completedAt: '2026-10-21T11:00:00.000Z',
  workType: { id: 'wt-1', slug: 'repairs', version: 3, fields: [{ key: 'title', label: 'Title', type: 'text', required: true }, { key: 'qty', label: 'Quantity', type: 'number', required: false }] },
};
const secret = 'a'.repeat(64);

function ctx(deadlineMs = 10_000): DeliveryContext {
  return { idempotencyKey: 'item-1:hook', deadlineMs, signal: new AbortController().signal };
}

describe('WebhookAdapter', () => {
  let receiver: Receiver;
  let adapter: WebhookAdapter;

  beforeAll(async () => {
    receiver = await startReceiver();
  });
  beforeEach(() => {
    receiver.received.length = 0;
    adapter = new WebhookAdapter({ fetch: receiver.fetch, lookup: publicLookup });
  });
  afterAll(() => receiver.close());

  it('POSTs { item, workType, completedAt } with the Idempotency-Key, signed with the output secret', async () => {
    const result = await adapter.deliver(item, { url: `${receiver.origin}/ok`, secret }, ctx());
    expect(result).toEqual({ status: 'delivered' });
    expect(receiver.received).toHaveLength(1);
    const [request] = receiver.received;
    expect(request?.method).toBe('POST');
    expect(request?.headers['idempotency-key']).toBe('item-1:hook');
    expect(request?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request?.body ?? '')).toEqual({
      item: { id: 'item-1', teamId: 'team-1', workTypeVersionId: 'wtv-1', data: { title: 'Fix the door', qty: 2 }, createdAt: '2026-10-21T10:00:00.000Z' },
      workType: { id: 'wt-1', slug: 'repairs', version: 3 },
      completedAt: '2026-10-21T11:00:00.000Z',
    });
  });

  it('signature verifies with the stored secret, and not with another', async () => {
    await adapter.deliver(item, { url: `${receiver.origin}/ok`, secret }, ctx());
    const [request] = receiver.received;
    const header = request?.headers['x-getworkdone-signature'] as string;
    expect(header).toBe(`sha256=${createHmac('sha256', secret).update(request?.body ?? '').digest('hex')}`);
    expect(verifySignature(secret, request?.body ?? '', header)).toBe(true);
    expect(verifySignature('b'.repeat(64), request?.body ?? '', header)).toBe(false);
    expect(verifySignature(secret, `${request?.body ?? ''} `, header)).toBe(false);
    expect(verifySignature(secret, request?.body ?? '', 'sha256=short')).toBe(false);
    expect(signBody(secret, 'x')).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('a target that sleeps 15 s is aborted at 10 s and returns retryable', async () => {
    const started = Date.now();
    const result = await adapter.deliver(item, { url: `${receiver.origin}/sleep`, secret }, ctx(10_000));
    const elapsed = Date.now() - started;
    expect(result).toEqual({ status: 'retryable', reason: 'timeout' });
    expect(elapsed).toBeGreaterThanOrEqual(9_900);
    expect(elapsed).toBeLessThan(12_000);
  }, 20_000);

  it('stops when the worker aborts the attempt', async () => {
    const controller = new AbortController();
    const pending = adapter.deliver(item, { url: `${receiver.origin}/sleep`, secret }, { ...ctx(), signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect(await pending).toEqual({ status: 'retryable', reason: 'timeout' });
  });

  it.each([
    ['http://', 'http://receiver.test/ok', 'https_required'],
    ['127.0.0.1', 'https://127.0.0.1/ok', 'blocked_address'],
    ['10.0.0.5', 'https://10.0.0.5/ok', 'blocked_address'],
    ['169.254.169.254', 'https://169.254.169.254/', 'blocked_address'],
    ['::1', 'https://[::1]/ok', 'blocked_address'],
    ['an IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]/ok', 'blocked_address'],
    ['127.0.0.1 written as a number', 'https://2130706433/ok', 'blocked_address'],
  ])('refuses %s without sending', async (_name, url, reason) => {
    const lookup = vi.fn(publicLookup);
    const fetchSpy = vi.fn(receiver.fetch);
    const refusing = new WebhookAdapter({ fetch: fetchSpy, lookup });
    expect(await refusing.deliver(item, { url, secret }, ctx())).toEqual({ status: 'failed', reason });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a DNS name resolving to a private address, checking every address it resolves to', async () => {
    const fetchSpy = vi.fn(receiver.fetch);
    const privateName = new WebhookAdapter({ fetch: fetchSpy, lookup: async () => [{ address: '203.0.113.10', family: 4 }, { address: '10.1.2.3', family: 4 }] });
    expect(await privateName.deliver(item, { url: `${receiver.origin}/ok`, secret }, ctx())).toEqual({ status: 'failed', reason: 'blocked_address' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('DNS rebinding: a name that resolves public for the check and private for the connection is refused, with no connection', async () => {
    let lookups = 0;
    const rebinding = new WebhookAdapter({
      lookup: async () => {
        lookups += 1;
        return [{ address: lookups === 1 ? '203.0.113.10' : '10.1.2.3', family: 4 }];
      },
    });
    expect(await rebinding.deliver(item, { url: 'https://rebind.example.test/hook', secret }, ctx())).toEqual({ status: 'failed', reason: 'blocked_address' });
    expect(lookups).toBe(2);
  });

  it('the connection is made to the address that was checked', async () => {
    // No test double for fetch: the real client resolves the name again through the adapter's own
    // lookup when it connects, so the address checked is the address dialled. (203.0.113.10 is a
    // documentation address: the dial goes nowhere and the attempt times out.)
    const connected: string[] = [];
    const pinned = new WebhookAdapter({ lookup: async (host) => (connected.push(host), [{ address: '203.0.113.10', family: 4 }]) });
    const result = await pinned.deliver(item, { url: 'https://pinned.example.test:8443/hook', secret }, ctx(2_000));
    expect(result.status).toBe('retryable');
    expect(connected).toEqual(['pinned.example.test', 'pinned.example.test']);
  });

  it('a name that does not resolve is retryable', async () => {
    const unresolved = new WebhookAdapter({ fetch: receiver.fetch, lookup: async () => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })) });
    expect(await unresolved.deliver(item, { url: `${receiver.origin}/ok`, secret }, ctx())).toEqual({ status: 'retryable', reason: 'dns_error' });
  });

  it('a 302 is not followed', async () => {
    const result = await adapter.deliver(item, { url: `${receiver.origin}/redirect`, secret }, ctx());
    expect(result).toEqual({ status: 'failed', reason: 'redirect_not_followed' });
    expect(receiver.received.map((r) => r.path)).toEqual(['/redirect']);
  });

  it('a 5xx is retryable and a 4xx is failed', async () => {
    expect(await adapter.deliver(item, { url: `${receiver.origin}/fail`, secret }, ctx())).toEqual({ status: 'retryable', reason: 'http_503' });
    expect(await adapter.deliver(item, { url: `${receiver.origin}/bad`, secret }, ctx())).toEqual({ status: 'failed', reason: 'http_400' });
  });

  it('a connection that fails is retryable', async () => {
    const down = new WebhookAdapter({ fetch: () => Promise.reject(new TypeError('fetch failed')), lookup: publicLookup });
    expect(await down.deliver(item, { url: `${receiver.origin}/ok`, secret }, ctx())).toEqual({ status: 'retryable', reason: 'network_error' });
  });

  it('a config that no longer parses, or has no secret, is failed', async () => {
    expect(await adapter.deliver(item, { url: `${receiver.origin}/ok` }, ctx())).toEqual({ status: 'failed', reason: 'invalid_config' });
    expect(await adapter.deliver(item, 'nonsense', ctx())).toEqual({ status: 'failed', reason: 'invalid_config' });
    expect(receiver.received).toHaveLength(0);
  });

  it('has kind webhook', () => {
    expect(adapter.kind).toBe('webhook');
  });
});

describe('isBlockedAddress', () => {
  it.each([
    '0.0.0.0', '10.0.0.5', '100.64.0.1', '127.0.0.1', '169.254.169.254', '169.254.170.2', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '192.0.0.8', '198.18.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:8.8.8.8', '64:ff9b::a00:1', '2002:7f00:1::', 'not an address',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['203.0.113.10', '8.8.8.8', '172.32.0.1', '2606:4700::1111'])('allows %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

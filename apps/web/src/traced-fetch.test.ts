import { describe, expect, it, vi } from 'vitest';
import { newTraceparent, tracedFetch } from './traced-fetch.js';

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;

describe('tracedFetch', () => {
  it('builds a W3C traceparent with a fresh non-zero trace id and span id each time', () => {
    const a = newTraceparent();
    const b = newTraceparent();
    expect(a).toMatch(TRACEPARENT);
    expect(b).toMatch(TRACEPARENT);
    expect(a.slice(3, 35)).not.toBe(b.slice(3, 35));
    expect(a).not.toContain('0'.repeat(32));
  });

  it('sends traceparent on every request and keeps the caller headers', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    await tracedFetch('/healthz', { headers: { accept: 'application/json' } }, fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe('/healthz');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('traceparent')).toMatch(TRACEPARENT);
  });

  it('retries id generation if the random source returns all zeros', () => {
    let calls = 0;
    const random = <T extends ArrayBufferView>(bytes: T): T => {
      calls += 1;
      if (calls > 2) new Uint8Array(bytes.buffer).fill(7);
      return bytes;
    };
    expect(newTraceparent(random)).toBe(`00-${'07'.repeat(16)}-${'07'.repeat(8)}-01`);
  });
});

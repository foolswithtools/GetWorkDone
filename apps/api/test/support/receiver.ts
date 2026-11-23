import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request the receiver got: its path, headers and raw body. */
export interface Received {
  path: string;
  method: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Receiver {
  /** The https origin webhook outputs point at; forwardingFetch sends it to this receiver. */
  origin: string;
  received: Received[];
  /** A fetch that sends `origin` URLs to the receiver over plain HTTP on loopback, and anything else nowhere. */
  fetch: (input: URL | string, init?: RequestInit) => Promise<Response>;
  close(): Promise<void>;
}

/**
 * A local webhook receiver for the adapter and delivery tests. A webhook output must be https and the
 * adapter refuses loopback, so the tests point outputs at `https://receiver.test`, resolve that name to a
 * public documentation address (publicLookup), and hand the adapter `fetch`, which rewrites the origin to
 * this server: every header, body, redirect and timeout is real HTTP.
 *
 * Paths: `/ok` answers 204, `/fail` 503, `/bad` 400, `/redirect` 302 to `/ok`, `/sleep` answers after 15 s.
 */
export async function startReceiver(): Promise<Receiver> {
  const received: Received[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const path = req.url ?? '/';
      received.push({ path, method: req.method ?? '', headers: req.headers, body });
      if (path === '/sleep') {
        const timer = setTimeout(() => res.writeHead(204).end(), 15_000);
        timers.add(timer);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      if (path === '/redirect') return void res.writeHead(302, { location: '/ok' }).end();
      if (path === '/fail') return void res.writeHead(503).end();
      if (path === '/bad') return void res.writeHead(400).end();
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = 'https://receiver.test';
  const forward = (input: URL | string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (!url.startsWith(origin)) return Promise.reject(new Error(`the test receiver only takes ${origin}`));
    return fetch(`http://127.0.0.1:${port}${url.slice(origin.length)}`, init);
  };
  return {
    origin,
    received,
    fetch: forward,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A DNS lookup that answers every name with one public (documentation) address. */
export const publicLookup = async (): Promise<{ address: string; family: number }[]> => [{ address: '203.0.113.10', family: 4 }];

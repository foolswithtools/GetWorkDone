import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Received {
  path: string | undefined;
  body: string;
}

// A stand-in OTLP/HTTP collector on an ephemeral loopback port: records each export and answers 200.
export async function fakeCollector(): Promise<{ endpoint: string; received: Received[]; close: () => Promise<void> }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      received.push({ path: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

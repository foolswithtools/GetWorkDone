import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RawResponse {
  status: number;
  contentType: string;
  text: string;
}

// supertest parses the URL with WHATWG rules, which turn `\` into `/`, so a path that must reach the
// app byte for byte (like curl --path-as-is) goes through node:http on a listening server instead.
/** GET `path` exactly as written. Listens on a free port if the server is not listening yet. */
export async function rawGet(server: Server, path: string): Promise<RawResponse> {
  if (!server.listening) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), text }));
    })
      .on('error', reject)
      .end();
  });
}

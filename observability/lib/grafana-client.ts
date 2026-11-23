// A small JSON client for the Grafana Cloud stack APIs and the OnCall API, modelled on the exemplar's
// observability/lib/grafana-client.ts @ 12a071e. Every request carries the stack's service-account
// token: as a bearer token to the stack, and bare to OnCall, which only accepts a header that starts
// with the token itself (grafana/oncall engine/apps/auth_token/auth.py) and also needs the stack URL in
// X-Grafana-URL. Errors name the method, path and status, never the token.

export type Json = Record<string, unknown>;

export class GrafanaApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${method} ${path} returned ${status}${detail ? `: ${detail}` : ''}`);
  }
}

export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
  /** `bearer` (the stack APIs, default) or `bare` (the OnCall API). */
  auth?: 'bearer' | 'bare';
  headers?: Record<string, string>;
}

export interface GrafanaClient {
  /** The parsed body, or undefined on 404. */
  get<T = Json>(path: string): Promise<T | undefined>;
  post<T = Json>(path: string, body: unknown): Promise<T>;
  put<T = Json>(path: string, body: unknown): Promise<T>;
  delete(path: string): Promise<void>;
  /**
   * Every `results` entry of a paginated OnCall list. Throws rather than return part of a list: a
   * `next` on another origin (the token never goes there) or more than MAX_PAGES pages.
   */
  list<T = Json>(path: string): Promise<T[]>;
}

const MAX_PAGES = 50;

export function createClient(options: ClientOptions): GrafanaClient {
  const base = new URL(options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`);

  function resolve(path: string): URL {
    return new URL(path.replace(/^\//, ''), base);
  }

  async function send(method: string, url: URL, body?: unknown): Promise<{ status: number; body: unknown }> {
    const authorization = options.auth === 'bare' ? options.token : `Bearer ${options.token}`;
    const headers: Record<string, string> = { accept: 'application/json', authorization, ...options.headers };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await options.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    const path = url.pathname + url.search;
    if (response.status === 404 && method === 'GET') return { status: 404, body: undefined };
    if (response.status >= 400) throw new GrafanaApiError(method, path, response.status, detailOf(parsed));
    return { status: response.status, body: parsed };
  }

  return {
    async get<T>(path: string) {
      return (await send('GET', resolve(path))).body as T | undefined;
    },
    async post<T>(path: string, body: unknown) {
      return (await send('POST', resolve(path), body)).body as T;
    },
    async put<T>(path: string, body: unknown) {
      return (await send('PUT', resolve(path), body)).body as T;
    },
    async delete(path: string) {
      await send('DELETE', resolve(path));
    },
    async list<T>(path: string) {
      const results: T[] = [];
      let url: URL | undefined = resolve(path);
      for (let page = 1; url; page++) {
        if (page > MAX_PAGES) throw new Error(`GET ${path}: more than ${MAX_PAGES} pages`);
        const body = (await send('GET', url)).body as { results?: T[]; next?: string | null } | undefined;
        results.push(...(body?.results ?? []));
        const next: URL | undefined = body?.next ? new URL(body.next) : undefined;
        // Never send the token to another host, whatever `next` says.
        if (next && next.origin !== base.origin) throw new Error(`GET ${path}: the next page is on another origin, ${next.origin}`);
        url = next;
      }
      return results;
    },
  };
}

function detailOf(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 200);
  if (body && typeof body === 'object') {
    const record = body as Json;
    for (const key of ['message', 'detail', 'error']) if (typeof record[key] === 'string') return (record[key] as string).slice(0, 200);
  }
  return '';
}

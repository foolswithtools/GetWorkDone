import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { expect } from 'vitest';
import { FakeIdentityProvider } from '../../src/modules/identity/fake.provider.js';
import { IDENTITY_PROVIDER, type VerifiedIdentity } from '../../src/modules/identity/identity.js';

/** The `name=value` pair of cookie `name` from a response's Set-Cookie headers, or undefined. */
export function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const header = res.headers['set-cookie'];
  const all = Array.isArray(header) ? header as string[] : typeof header === 'string' ? [header] : [];
  return all.map((c) => c.split(';')[0]!).find((pair) => pair.startsWith(`${name}=`) && pair.length > name.length + 1);
}

export interface SignedIn {
  cookie: string;
  csrfToken: string;
  get(path: string): request.Test;
  /** A POST carrying the session cookie and the X-GWD-CSRF header. */
  post(path: string, body?: object): request.Test;
  /** A DELETE carrying the session cookie and the X-GWD-CSRF header. */
  delete(path: string): request.Test;
}

/**
 * Sign in through the real routes with the fake provider (IDENTITY_PROVIDER=fake under NODE_ENV=test,
 * vitest.shared.ts): /auth/login, then /auth/callback with the login cookie, then /api/v1/me for the
 * CSRF token. A string is shorthand for a subject with a matching test email. `inBrowserWith` is a
 * session cookie the browser already holds, sent with the callback as a browser would (GWP#56).
 */
export async function signIn(app: INestApplication, who: VerifiedIdentity | string, { inBrowserWith }: { inBrowserWith?: string } = {}): Promise<SignedIn> {
  const identity = typeof who === 'string' ? { subject: who, email: `${who}@example.test` } : who;
  const fake = app.get<FakeIdentityProvider>(IDENTITY_PROVIDER);
  expect(fake).toBeInstanceOf(FakeIdentityProvider);
  fake.signInAs(identity);
  const server = app.getHttpServer();
  const login = await request(server).get('/auth/login').expect(302);
  const location = new URL(login.headers.location as string, 'http://gwd.test');
  const callback = await request(server).get(`${location.pathname}${location.search}`).set('cookie', [cookieFrom(login, '__Host-gwd_login')!, ...(inBrowserWith ? [inBrowserWith] : [])].join('; ')).expect(302);
  const cookie = cookieFrom(callback, '__Host-gwd_session')!;
  const me = await request(server).get('/api/v1/me').set('cookie', cookie).expect(200);
  const csrfToken = me.body.csrfToken as string;
  return {
    cookie,
    csrfToken,
    get: (path) => request(server).get(path).set('cookie', cookie),
    post: (path, body = {}) => request(server).post(path).set('cookie', cookie).set('x-gwd-csrf', csrfToken).send(body),
    delete: (path) => request(server).delete(path).set('cookie', cookie).set('x-gwd-csrf', csrfToken),
  };
}

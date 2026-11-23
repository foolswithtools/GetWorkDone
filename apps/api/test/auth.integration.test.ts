import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createPrismaClient } from '@getworkdone/db';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { SECURITY_HEADERS } from '../src/common/security-headers.js';
import { PostgresLoginRateStore } from '../src/modules/auth/login-rate-limit.js';
import type { Database } from '../src/modules/database/database.js';
import { ItemsService } from '../src/modules/items/items.service.js';
import { definition } from './support/definitions.js';
import { cookieFrom, signIn, type SignedIn } from './support/identity.js';
import { fakeWebDist } from './support/web-dist.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const tokenOf = (cookie: string) => cookie.slice(cookie.indexOf('=') + 1);
// Subjects are unique per run, so a database kept from an earlier run does not add teams to them.
const run = randomUUID().slice(0, 8);
const sub = (name: string) => `auth-${name}-${run}`;

// Sign-in, sessions, CSRF and team authorization through the real routes, with the fake identity
// provider standing in for the issuer (GWP#3; the OIDC checks themselves are oidc.provider.test.ts).
describe('auth', () => {
  let app: INestApplication;
  const db = createPrismaClient();
  const server = () => app.getHttpServer();
  let alice: SignedIn;
  let bob: SignedIn;
  let teamA: string;
  let teamB: string;
  let itemB: string;

  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
    alice = await signIn(app, { subject: sub('alice'), email: 'alice@example.test', displayName: 'Alice' });
    bob = await signIn(app, sub('bob'));
    teamA = (await alice.post('/api/v1/teams', { name: 'Auth A' }).expect(201)).body.id;
    teamB = (await bob.post('/api/v1/teams', { name: 'Auth B' }).expect(201)).body.id;
    const workTypeB = (await bob.post(`/api/v1/teams/${teamB}/work-types`, { slug: 'orders', definition: definition() }).expect(201)).body;
    itemB = (await app.get(ItemsService).create(teamB, { workTypeVersionId: workTypeB.version.id, data: { title: 'B' } }, sub('bob'))).id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  describe('GET /api/v1/me', () => {
    it('is 401 without a cookie, and with a cookie that names no session', async () => {
      await request(server()).get('/api/v1/me').expect(401);
      await request(server()).get('/api/v1/me').set('cookie', '__Host-gwd_session=not-a-session').expect(401);
    });

    it('is 200 with a valid session: the subject, email, display name, CSRF token and team memberships', async () => {
      const me = await alice.get('/api/v1/me').expect(200);
      expect(me.body).toEqual({ subject: sub('alice'), email: 'alice@example.test', displayName: 'Alice', csrfToken: alice.csrfToken, teams: [{ id: teamA, name: 'Auth A', role: 'admin' }] });
    });

    it('with a session, a repeated leading slash is a JSON 404, never index.html (GWP#15)', async () => {
      for (const path of ['//api/v1/me', `//api/v1/teams/${teamA}/work-types`]) {
        const res = await alice.get(path);
        expect(res.status, path).toBe(404);
        expect(res.headers['content-type'], path).toContain('application/json');
        expect(res.text, path).not.toContain('<title>');
      }
    });
  });

  describe('/auth/callback', () => {
    it('sets __Host-gwd_session with HttpOnly, Secure, SameSite=Lax, Path=/, no Domain and an 8-hour absolute expiry, and stores only its hash', async () => {
      const login = await request(server()).get('/auth/login').expect(302);
      const loginCookie = login.headers['set-cookie'] as unknown as string[];
      // The __Host- prefix (D-087): the browser keeps the cookie only if it is Secure, Path=/ and has no Domain.
      const loginSetCookie = loginCookie.find((c) => c.startsWith('__Host-gwd_login='))!;
      expect(loginSetCookie).toMatch(/HttpOnly/);
      expect(loginSetCookie).toContain('Secure');
      expect(loginSetCookie).toContain('Path=/;');
      expect(loginSetCookie).not.toMatch(/Domain=/i);
      const location = new URL(login.headers.location as string, 'http://gwd.test');
      const before = Date.now();
      const callback = await request(server()).get(`${location.pathname}${location.search}`).set('cookie', cookieFrom(login, '__Host-gwd_login')!).expect(302);
      expect(callback.headers.location).toBe('/');
      const setCookie = (callback.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-gwd_session='))!;
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Path=/;');
      expect(setCookie).not.toMatch(/Domain=/i);
      expect(setCookie).toContain('Max-Age=28800');
      const token = tokenOf(cookieFrom(callback, '__Host-gwd_session')!);
      expect(await db.session.findUnique({ where: { id: token } })).toBeNull();
      const row = await db.session.findUniqueOrThrow({ where: { id: sha256(token) } });
      expect(row.expiresAt.getTime() - before).toBeGreaterThanOrEqual(8 * 3600 * 1000 - 1000);
      expect(row.expiresAt.getTime() - before).toBeLessThanOrEqual(8 * 3600 * 1000 + 5000);
      // The login cookie is cleared and its row is gone: a sign-in is used once.
      expect((callback.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-gwd_login='))).toMatch(/Path=\/;.*Expires=Thu, 01 Jan 1970.*Secure/);
      await request(server()).get(`${location.pathname}${location.search}`).set('cookie', cookieFrom(login, '__Host-gwd_login')!).expect(400);
    });

    it('a mismatched state returns 400 and starts no session', async () => {
      const login = await request(server()).get('/auth/login').expect(302);
      const location = new URL(login.headers.location as string, 'http://gwd.test');
      location.searchParams.set('state', 'forged-state');
      const sessions = await db.session.count();
      const res = await request(server()).get(`${location.pathname}${location.search}`).set('cookie', cookieFrom(login, '__Host-gwd_login')!).expect(400);
      expect(cookieFrom(res, '__Host-gwd_session')).toBeUndefined();
      expect(await db.session.count()).toBe(sessions);
    });

    it('a callback with no sign-in in progress, or an error from the issuer, returns 400', async () => {
      await request(server()).get('/auth/callback?code=x&state=y').expect(400);
      const login = await request(server()).get('/auth/login').expect(302);
      const state = new URL(login.headers.location as string, 'http://gwd.test').searchParams.get('state');
      await request(server()).get(`/auth/callback?error=access_denied&state=${state}`).set('cookie', cookieFrom(login, '__Host-gwd_login')!).expect(400);
    });

    it('a sign-in cookie without the __Host- prefix, as a sibling host could set on a parent domain, is ignored: 400 (GWP#17, D-087)', async () => {
      const login = await request(server()).get('/auth/login').expect(302);
      const location = new URL(login.headers.location as string, 'http://gwd.test');
      const token = tokenOf(cookieFrom(login, '__Host-gwd_login')!);
      const sessions = await db.session.count();
      const res = await request(server()).get(`${location.pathname}${location.search}`).set('cookie', `gwd_login=${token}`).expect(400);
      expect(cookieFrom(res, '__Host-gwd_session')).toBeUndefined();
      expect(await db.session.count()).toBe(sessions);
      // The sign-in was not used: the real cookie still completes it.
      await request(server()).get(`${location.pathname}${location.search}`).set('cookie', `__Host-gwd_login=${token}`).expect(302);
    });

    it('a session cookie without the __Host- prefix is not a session: 401 (GWP#17, D-087)', async () => {
      await request(server()).get('/api/v1/me').set('cookie', `gwd_session=${tokenOf(alice.cookie)}`).expect(401);
    });

    it('a code the provider refuses is 401 and starts no session', async () => {
      const login = await request(server()).get('/auth/login').expect(302);
      const state = new URL(login.headers.location as string, 'http://gwd.test').searchParams.get('state');
      const res = await request(server()).get(`/auth/callback?code=never-issued&state=${state}`).set('cookie', cookieFrom(login, '__Host-gwd_login')!).expect(401);
      expect(cookieFrom(res, '__Host-gwd_session')).toBeUndefined();
    });
  });

  describe('team authorization', () => {
    it('a member of team A gets 403 on team B, and the request writes no ItemEvent row', async () => {
      const events = await db.itemEvent.count();
      await alice.get(`/api/v1/teams/${teamB}/work-types`).expect(403);
      await alice.get(`/api/v1/teams/${teamB}/items/${itemB}`).expect(403);
      await alice.post(`/api/v1/teams/${teamB}/work-types`, { slug: 'intrude', definition: definition() }).expect(403);
      expect(await db.itemEvent.count()).toBe(events);
      expect(await db.workType.count({ where: { teamId: teamB, slug: 'intrude' } })).toBe(0);
    });

    it('a team that does not exist, or a malformed id, is 403: membership is checked before anything is read', async () => {
      await alice.get('/api/v1/teams/00000000-0000-4000-8000-000000000000/work-types').expect(403);
      await alice.get('/api/v1/teams/not-a-uuid/items/also-not').expect(403);
    });

    it('a member gets 403 on a work-type write; reading is allowed; an admin can write', async () => {
      await db.teamMember.create({ data: { teamId: teamB, subject: sub('carol'), role: 'member' } });
      const carol = await signIn(app, sub('carol'));
      await carol.get(`/api/v1/teams/${teamB}/work-types`).expect(200);
      await carol.get(`/api/v1/teams/${teamB}/items/${itemB}`).expect(200);
      await carol.post(`/api/v1/teams/${teamB}/work-types`, { slug: 'by-member', definition: definition() }).expect(403);
      await bob.post(`/api/v1/teams/${teamB}/work-types`, { slug: 'by-admin', definition: definition() }).expect(201);
    });
  });

  describe('CSRF', () => {
    it('a POST without the X-GWD-CSRF header returns 403, as does a wrong one; with it the POST succeeds', async () => {
      const teams = await db.team.count();
      await request(server()).post('/api/v1/teams').set('cookie', alice.cookie).send({ name: 'No header' }).expect(403);
      await request(server()).post('/api/v1/teams').set('cookie', alice.cookie).set('x-gwd-csrf', 'wrong').send({ name: 'Wrong header' }).expect(403);
      await request(server()).post('/api/v1/teams').set('cookie', alice.cookie).set('x-gwd-csrf', bob.csrfToken).send({ name: 'Other session' }).expect(403);
      expect(await db.team.count()).toBe(teams);
      await alice.post('/api/v1/teams', { name: 'With header' }).expect(201);
    });

    it('the guards\' 403s and the sign-in 302 carry the security headers (GWP#48, docs/security.md)', async () => {
      const answers = [
        await request(server()).post('/api/v1/teams').set('cookie', alice.cookie).send({ name: 'No header' }).expect(403),
        await alice.get(`/api/v1/teams/${teamB}/work-types`).expect(403),
        await request(server()).get('/auth/login').expect(302),
      ];
      for (const res of answers) for (const [header, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers[header.toLowerCase()], header).toBe(value);
    });

    it('a POST with no session at all is 401, not 403: authentication is checked first', async () => {
      await request(server()).post('/api/v1/teams').send({ name: 'x' }).expect(401);
    });
  });

  describe('sessions', () => {
    it('POST /auth/logout needs the CSRF header, then deletes the row and clears the cookie', async () => {
      const dave = await signIn(app, sub('dave'));
      await request(server()).post('/auth/logout').set('cookie', dave.cookie).expect(403);
      await dave.get('/api/v1/me').expect(200);
      const res = await dave.post('/auth/logout').expect(204);
      expect((res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-gwd_session='))).toMatch(/Path=\/;.*Expires=Thu, 01 Jan 1970.*HttpOnly.*Secure.*SameSite=Lax/);
      expect(await db.session.findUnique({ where: { id: sha256(tokenOf(dave.cookie)) } })).toBeNull();
      await dave.get('/api/v1/me').expect(401);
    });

    it('POST /auth/logout with no session is 204', async () => {
      await request(server()).post('/auth/logout').expect(204);
    });

    // GWP#56: a sign-in replaces the session the browser presents, whoever it belonged to.
    it('a second sign-in in one browser ends the first session: 302, a new cookie, and the first token is 401', async () => {
      const first = await signIn(app, sub('fran'));
      const second = await signIn(app, sub('fran'), { inBrowserWith: first.cookie });
      expect(second.cookie).not.toBe(first.cookie);
      await first.get('/api/v1/me').expect(401);
      await second.get('/api/v1/me').expect(200);
      expect(await db.session.count({ where: { subject: sub('fran') } })).toBe(1);
    });

    it('a sign-in by another person in that browser ends the earlier person\'s session too', async () => {
      const gail = await signIn(app, sub('gail'));
      const hank = await signIn(app, sub('hank'), { inBrowserWith: gail.cookie });
      await gail.get('/api/v1/me').expect(401);
      await hank.get('/api/v1/me').expect(200);
      expect(await db.session.count({ where: { subject: sub('gail') } })).toBe(0);
    });

    it('a sign-in leaves the same person\'s session in another browser alone', async () => {
      const laptop = await signIn(app, sub('ivy'));
      await signIn(app, sub('ivy'));
      await laptop.get('/api/v1/me').expect(200);
      expect(await db.session.count({ where: { subject: sub('ivy') } })).toBe(2);
    });

    it('POST /auth/logout/all ends every session of the subject (204, cookie cleared); another subject\'s session stays', async () => {
      const phone = await signIn(app, sub('jack'));
      const laptop = await signIn(app, sub('jack'));
      const other = await signIn(app, sub('kate'));
      const res = await phone.post('/auth/logout/all').expect(204);
      expect((res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('__Host-gwd_session='))).toMatch(/Path=\/;.*Expires=Thu, 01 Jan 1970.*HttpOnly.*Secure.*SameSite=Lax/);
      await phone.get('/api/v1/me').expect(401);
      await laptop.get('/api/v1/me').expect(401);
      await other.get('/api/v1/me').expect(200);
      expect(await db.session.count({ where: { subject: sub('jack') } })).toBe(0);
    });

    it('POST /auth/logout/all without X-GWD-CSRF is 403 and deletes nothing; without a session it is 401', async () => {
      const phone = await signIn(app, sub('liam'));
      await signIn(app, sub('liam'));
      await request(server()).post('/auth/logout/all').set('cookie', phone.cookie).expect(403);
      expect(await db.session.count({ where: { subject: sub('liam') } })).toBe(2);
      await phone.get('/api/v1/me').expect(200);
      await request(server()).post('/auth/logout/all').expect(401);
      await request(server()).post('/auth/logout/all').set('cookie', '__Host-gwd_session=not-a-session').expect(401);
      expect(await db.session.count({ where: { subject: sub('liam') } })).toBe(2);
    });

    it('a session past its absolute expiry is 401, and its row is removed', async () => {
      const erin = await signIn(app, sub('erin'));
      const id = sha256(tokenOf(erin.cookie));
      await db.session.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await erin.get('/api/v1/me').expect(401);
      expect(await db.session.findUnique({ where: { id } })).toBeNull();
    });
  });
});

// GWP#16, GWP#32: a per-address limit on GET /auth/login, counted in Postgres so every API task shares
// it. The integration partition raises LOGIN_RATE_LIMIT for the other files' sign-ins
// (vitest.integration.config.ts); here it is the default, 20, and each test starts with no counts.
describe('GET /auth/login rate limit', () => {
  const db = createPrismaClient();
  beforeEach(async () => {
    vi.stubEnv('LOGIN_RATE_LIMIT', '20');
    await db.loginRateWindow.deleteMany({});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await db.loginRateWindow.deleteMany({});
    await db.$disconnect();
  });

  async function appWith(options: { trustProxyHops?: number } = {}) {
    const app = await createApp({ webDistDir: fakeWebDist(), logger: false, ...options });
    // Listening once: supertest would otherwise open a server per request, 100 at a time.
    await app.listen(0, '127.0.0.1');
    return app;
  }

  it('100 rapid GET /auth/login calls from one address create at most the limit (20) of LoginAttempt rows; the rest are 429', async () => {
    const app = await appWith();
    try {
      const responses = await Promise.all(Array.from({ length: 100 }, () => request(app.getHttpServer()).get('/auth/login')));
      const redirected = responses.filter((r) => r.status === 302);
      const limited = responses.filter((r) => r.status === 429);
      expect(redirected).toHaveLength(20);
      expect(limited).toHaveLength(80);
      expect(Number(limited[0]!.headers['retry-after'])).toBeGreaterThan(0);
      expect(limited.every((r) => cookieFrom(r, '__Host-gwd_login') === undefined)).toBe(true);
      const ids = redirected.map((r) => sha256(tokenOf(cookieFrom(r, '__Host-gwd_login')!)));
      expect(await db.loginAttempt.count({ where: { id: { in: ids } } })).toBe(20);
    } finally {
      await app.close();
    }
  });

  it('two apps on one database share the count: 15 calls from one address through each give 20 redirects and 10 answers of 429', async () => {
    const [one, two] = [await appWith(), await appWith()];
    try {
      const responses = await Promise.all([one, two].flatMap((app) => Array.from({ length: 15 }, () => request(app.getHttpServer()).get('/auth/login'))));
      expect(responses.filter((r) => r.status === 302)).toHaveLength(20);
      const limited = responses.filter((r) => r.status === 429);
      expect(limited).toHaveLength(10);
      expect(limited.every((r) => Number(r.headers['retry-after']) > 0)).toBe(true);
    } finally {
      await one.close();
      await two.close();
    }
  });

  it('100 rapid GET /auth/login calls from one address split across two apps create at most the limit (20) of LoginAttempt rows', async () => {
    const [one, two] = [await appWith(), await appWith()];
    try {
      const responses = await Promise.all(Array.from({ length: 100 }, (_, n) => request((n % 2 ? one : two).getHttpServer()).get('/auth/login')));
      const redirected = responses.filter((r) => r.status === 302);
      expect(redirected).toHaveLength(20);
      expect(responses.filter((r) => r.status === 429)).toHaveLength(80);
      const ids = redirected.map((r) => sha256(tokenOf(cookieFrom(r, '__Host-gwd_login')!)));
      expect(await db.loginAttempt.count({ where: { id: { in: ids } } })).toBe(20);
    } finally {
      await one.close();
      await two.close();
    }
  });

  it('a restarted app keeps the count: a new app on the same database still answers 429', async () => {
    const first = await appWith();
    try {
      for (let n = 0; n < 20; n += 1) await request(first.getHttpServer()).get('/auth/login').expect(302);
    } finally {
      await first.close();
    }
    const second = await appWith();
    try {
      await request(second.getHttpServer()).get('/auth/login').expect(429);
    } finally {
      await second.close();
    }
  });

  it('the Postgres store counts a key in its window, starts again a minute after its first take, and writes UTC as Prisma reads it', async () => {
    const store = new PostgresLoginRateStore({ client: db } as unknown as Database);
    const start = new Date('2026-10-24T12:00:00.123Z');
    const at = (ms: number) => new Date(start.getTime() + ms);
    expect(await store.take('store-key', start, 60_000)).toEqual({ windowStart: start, count: 1 });
    expect(await store.take('store-key', at(59_999), 60_000)).toEqual({ windowStart: start, count: 2 });
    expect(await store.take('other-key', at(59_999), 60_000)).toEqual({ windowStart: at(59_999), count: 1 });
    expect(await store.take('store-key', at(60_000), 60_000)).toEqual({ windowStart: at(60_000), count: 1 });
    expect(await db.loginRateWindow.findUnique({ where: { key: 'store-key' } })).toEqual({ key: 'store-key', windowStart: at(60_000), count: 1 });
  });

  it('with the database unreachable, GET /auth/login answers 503 and sets no __Host-gwd_login cookie', async () => {
    // Port 1 on loopback refuses the connection, so the store's query fails at once.
    vi.stubEnv('DATABASE_URL', 'postgresql://nobody:nothing@127.0.0.1:1/none');
    const app = await appWith();
    try {
      const res = await request(app.getHttpServer()).get('/auth/login').expect(503);
      expect(res.body.message).toBe('Sign-in is unavailable; try again shortly');
      expect(cookieFrom(res, '__Host-gwd_login')).toBeUndefined();
      expect(res.headers['retry-after']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('without TRUST_PROXY_HOPS, X-Forwarded-For does not change the address that is counted', async () => {
    const app = await appWith();
    try {
      for (let n = 0; n < 20; n += 1) await request(app.getHttpServer()).get('/auth/login').set('x-forwarded-for', `198.51.100.${n}`).expect(302);
      await request(app.getHttpServer()).get('/auth/login').set('x-forwarded-for', '198.51.100.99').expect(429);
    } finally {
      await app.close();
    }
  });

  it('behind one trusted proxy (the ALB), each X-Forwarded-For client has its own limit', async () => {
    const app = await appWith({ trustProxyHops: 1 });
    try {
      for (let n = 0; n < 20; n += 1) await request(app.getHttpServer()).get('/auth/login').set('x-forwarded-for', '203.0.113.7').expect(302);
      await request(app.getHttpServer()).get('/auth/login').set('x-forwarded-for', '203.0.113.7').expect(429);
      // A client cannot reset its count by prepending its own X-Forwarded-For entry: the ALB appends the
      // address it saw, and one trusted hop reads only that last entry.
      await request(app.getHttpServer()).get('/auth/login').set('x-forwarded-for', '10.9.9.9, 203.0.113.7').expect(429);
      await request(app.getHttpServer()).get('/auth/login').set('x-forwarded-for', '198.51.100.1').expect(302);
    } finally {
      await app.close();
    }
  });
});

import { BadRequestException, ForbiddenException, HttpException, ServiceUnavailableException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Prisma, type LoginAttempt, type Session } from '@getworkdone/db';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { CsrfGuard } from '../src/common/csrf.guard.js';
import { setIdentity } from '../src/common/identity.js';
import { RequireTeamRole, TeamMemberGuard } from '../src/common/team-member.guard.js';
import { AuthController } from '../src/modules/auth/auth.controller.js';
import { trustProxyHops } from '../src/app.js';
import { readCookie } from '../src/modules/auth/cookies.js';
import { clientKey, LOGIN_RATE_LIMIT, LoginRateLimitGuard, loginRateLimitFromEnv, RateLimiter, rateVerdict, type LoginRateStore } from '../src/modules/auth/login-rate-limit.js';
import { MeController } from '../src/modules/auth/me.controller.js';
import { codeChallengeFor, hashToken, IDENTITY_RETENTION_MS, sameSecret, SessionsService } from '../src/modules/auth/sessions.service.js';
import type { Database } from '../src/modules/database/database.js';
import type { R4cSigner } from '../src/modules/r4c/signing-key.js';
import { FakeIdentityProvider } from '../src/modules/identity/fake.provider.js';
import { IdentityError, type IdentityProvider } from '../src/modules/identity/identity.js';

// Partition `unit`: the sign-in pieces with the database stubbed; auth.integration.test.ts runs them
// together against Postgres.

function context(req: Partial<Request>, { type = 'http', handler = () => undefined }: { type?: string; handler?: () => unknown } = {}): ExecutionContext {
  return { getType: () => type, switchToHttp: () => ({ getRequest: () => req }), getHandler: () => handler, getClass: () => Object } as unknown as ExecutionContext;
}

function response() {
  return { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as Response & { cookie: ReturnType<typeof vi.fn>; clearCookie: ReturnType<typeof vi.fn> };
}

const LOGIN: LoginAttempt = { id: 'h', state: 'the-state', nonce: 'the-nonce', codeVerifier: 'the-verifier', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };

function sessionsStub(overrides: Partial<SessionsService> = {}): SessionsService {
  return {
    newLogin: () => ({ token: 'login-token', state: 'the-state', nonce: 'the-nonce', codeVerifier: 'the-verifier', codeChallenge: 'the-challenge' }),
    saveLogin: vi.fn(async () => undefined),
    takeLogin: vi.fn(async (token: string) => (token === 'login-token' ? LOGIN : null)),
    create: vi.fn(async () => ({ token: 'session-token', session: {} as Session })),
    delete: vi.fn(async () => undefined),
    deleteForSubject: vi.fn(async () => 2),
    ...overrides,
  } as unknown as SessionsService;
}

const provider = (overrides: Partial<IdentityProvider> = {}): IdentityProvider => ({
  name: 'stub',
  authorizationUrl: async ({ state }) => `https://idp.example.test/authorize?state=${state}`,
  exchangeCode: async () => ({ subject: 's', email: 'e@example.test' }),
  ...overrides,
});

const withLoginCookie = { headers: { cookie: '__Host-gwd_login=login-token' } } as unknown as Request;

describe('AuthController', () => {
  it('login saves the sign-in, sets __Host-gwd_login (HttpOnly, Secure, Lax, /, 10 minutes) and redirects to the issuer', async () => {
    const sessions = sessionsStub();
    const res = response();
    expect(await new AuthController(sessions, provider()).login(res)).toEqual({ url: 'https://idp.example.test/authorize?state=the-state', statusCode: 302 });
    expect(sessions.saveLogin).toHaveBeenCalled();
    expect(res.cookie).toHaveBeenCalledWith('__Host-gwd_login', 'login-token', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600_000 });
  });

  it('login is 503 with no provider configured, or when the issuer cannot be reached; nothing is saved', async () => {
    const sessions = sessionsStub();
    await expect(new AuthController(sessions, null).login(response())).rejects.toBeInstanceOf(ServiceUnavailableException);
    const down = provider({ authorizationUrl: async () => { throw new IdentityError('discovery_failed'); } });
    await expect(new AuthController(sessions, down).login(response())).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(sessions.saveLogin).not.toHaveBeenCalled();
    const broken = provider({ authorizationUrl: async () => { throw new TypeError('bug'); } });
    await expect(new AuthController(sessions, broken).login(response())).rejects.toBeInstanceOf(TypeError);
  });

  it('callback sets __Host-gwd_session (HttpOnly, Secure, Lax, /, 8 hours) after the provider verifies the code', async () => {
    const exchangeCode = vi.fn(async () => ({ subject: 's', email: 'e@example.test' }));
    const res = response();
    expect(await new AuthController(sessionsStub(), provider({ exchangeCode })).callback({ code: 'c', state: 'the-state' }, withLoginCookie, res)).toEqual({ url: '/', statusCode: 302 });
    expect(exchangeCode).toHaveBeenCalledWith({ code: 'c', nonce: 'the-nonce', codeVerifier: 'the-verifier' });
    expect(res.clearCookie).toHaveBeenCalledWith('__Host-gwd_login', expect.objectContaining({ path: '/' }));
    expect(res.cookie).toHaveBeenCalledWith('__Host-gwd_session', 'session-token', { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 28_800_000 });
  });

  it('callback deletes the session the browser presents before it creates the new one, and deletes nothing without one (GWP#56)', async () => {
    const order: string[] = [];
    const sessions = sessionsStub({
      delete: vi.fn(async (token: string) => { order.push(`delete ${token}`); }),
      create: vi.fn(async () => { order.push('create'); return { token: 'session-token', session: {} as Session }; }),
    });
    const both = { headers: { cookie: '__Host-gwd_session=old-token; __Host-gwd_login=login-token' } } as unknown as Request;
    await new AuthController(sessions, provider()).callback({ code: 'c', state: 'the-state' }, both, response());
    expect(order).toEqual(['delete old-token', 'create']);
    order.length = 0;
    await new AuthController(sessions, provider()).callback({ code: 'c', state: 'the-state' }, withLoginCookie, response());
    expect(order).toEqual(['create']);
    expect(sessions.delete).toHaveBeenCalledTimes(1);
  });

  it('callback keeps the presented session when the sign-in fails', async () => {
    const sessions = sessionsStub();
    const refused = provider({ exchangeCode: async () => { throw new IdentityError('bad_signature'); } });
    const both = { headers: { cookie: '__Host-gwd_session=old-token; __Host-gwd_login=login-token' } } as unknown as Request;
    await expect(new AuthController(sessions, refused).callback({ code: 'c', state: 'the-state' }, both, response())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions.delete).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('callback is 400 without a sign-in, with a wrong, missing or non-string state, with an issuer error or without a code', async () => {
    const controller = new AuthController(sessionsStub(), provider());
    const noCookie = { headers: {} } as Request;
    await expect(controller.callback({ code: 'c', state: 'the-state' }, noCookie, response())).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.callback({ code: 'c', state: 'the-state' }, { headers: { cookie: '__Host-gwd_login=other' } } as unknown as Request, response())).rejects.toBeInstanceOf(BadRequestException);
    for (const query of [{ code: 'c', state: 'wrong' }, { code: 'c' }, { code: 'c', state: ['the-state'] }, { error: 'access_denied', state: 'the-state' }, { state: 'the-state' }]) {
      await expect(controller.callback(query, withLoginCookie, response()), JSON.stringify(query)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('callback is 401 when the provider refuses the code, 503 with no provider, and rethrows anything else', async () => {
    const refused = provider({ exchangeCode: async () => { throw new IdentityError('nonce_mismatch'); } });
    await expect(new AuthController(sessionsStub(), refused).callback({ code: 'c', state: 'the-state' }, withLoginCookie, response())).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(new AuthController(sessionsStub(), null).callback({ code: 'c', state: 'the-state' }, withLoginCookie, response())).rejects.toBeInstanceOf(ServiceUnavailableException);
    const broken = provider({ exchangeCode: async () => { throw new TypeError('bug'); } });
    await expect(new AuthController(sessionsStub(), broken).callback({ code: 'c', state: 'the-state' }, withLoginCookie, response())).rejects.toBeInstanceOf(TypeError);
  });

  it('logout deletes the session behind the cookie and clears it; with no cookie it only clears', async () => {
    const sessions = sessionsStub();
    const res = response();
    await new AuthController(sessions, null).logout({ headers: { cookie: '__Host-gwd_session=tok' } } as unknown as Request, res);
    expect(sessions.delete).toHaveBeenCalledWith('tok');
    expect(res.clearCookie).toHaveBeenCalledWith('__Host-gwd_session', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    await new AuthController(sessions, null).logout({ headers: {} } as Request, response());
    expect(sessions.delete).toHaveBeenCalledTimes(1);
  });
});

describe('AuthController logoutAll (GWP#56)', () => {
  it('deletes every session of the signed-in subject and clears the cookie', async () => {
    const sessions = sessionsStub();
    const res = response();
    const req = { headers: { cookie: '__Host-gwd_session=tok' } } as unknown as Request;
    setIdentity(req, { subject: 'sub-1' }, { id: 'h', csrfToken: 'c' });
    await new AuthController(sessions, null).logoutAll(req, res);
    expect(sessions.deleteForSubject).toHaveBeenCalledWith('sub-1');
    expect(res.clearCookie).toHaveBeenCalledWith('__Host-gwd_session', { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  });

  it('is 401 without a session and deletes nothing', async () => {
    const sessions = sessionsStub();
    const res = response();
    await expect(new AuthController(sessions, null).logoutAll({ headers: { cookie: '__Host-gwd_session=gone' } } as unknown as Request, res)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(sessions.deleteForSubject).not.toHaveBeenCalled();
    expect(res.clearCookie).not.toHaveBeenCalled();
  });
});

describe('MeController', () => {
  it('returns the identity with its CSRF token and teams; email and token default to empty strings', async () => {
    const db = { client: { teamMember: { findMany: async () => [{ role: 'member', team: { id: 't', name: 'T' } }] } } } as unknown as Database;
    const req = {} as Request;
    setIdentity(req, { subject: 's', email: 'e@example.test', displayName: 'S' }, { id: 'h', csrfToken: 'x' });
    expect(await new MeController(db, null).me(req)).toEqual({ subject: 's', email: 'e@example.test', displayName: 'S', csrfToken: 'x', teams: [{ id: 't', name: 'T', role: 'member' }] });
    const bare = {} as Request;
    setIdentity(bare, { subject: 's' });
    expect(await new MeController(db, null).me(bare)).toMatchObject({ email: '', csrfToken: '' });
    await expect(new MeController(db, null).me({} as Request)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('adds r4c.appId only when the instance has a request-4-change signing key (GWP#10)', async () => {
    const db = { client: { teamMember: { findMany: async () => [] } } } as unknown as Database;
    const req = {} as Request;
    setIdentity(req, { subject: 's', email: 'e@example.test' }, { id: 'h', csrfToken: 'x' });
    expect(await new MeController(db, null).me(req)).not.toHaveProperty('r4c');
    const signer = { appId: 'getworkdone-dev' } as R4cSigner;
    expect((await new MeController(db, signer).me(req)).r4c).toEqual({ appId: 'getworkdone-dev' });
  });
});

describe('CsrfGuard', () => {
  const guard = new CsrfGuard();
  const signedIn = (method: string, headers: Record<string, string> = {}) => {
    const req = { method, headers } as unknown as Request;
    setIdentity(req, { subject: 's' }, { id: 'h', csrfToken: 'tok' });
    return req;
  };

  it('a state-changing request with a session needs the matching X-GWD-CSRF header', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(() => guard.canActivate(context(signedIn(method))), method).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context(signedIn(method, { 'x-gwd-csrf': 'nope' }))), method).toThrow(ForbiddenException);
      expect(guard.canActivate(context(signedIn(method, { 'x-gwd-csrf': 'tok' }))), method).toBe(true);
    }
  });

  it('safe methods, requests without a session and non-HTTP contexts pass', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(guard.canActivate(context(signedIn(method)))).toBe(true);
    expect(guard.canActivate(context({ method: 'POST', headers: {} } as Request))).toBe(true);
    expect(guard.canActivate(context({}, { type: 'rpc' }))).toBe(true);
  });
});

describe('TeamMemberGuard', () => {
  const roles: Record<string, 'admin' | 'member'> = { admin: 'admin', member: 'member' };
  const db = { client: { teamMember: { findUnique: async ({ where }: { where: { teamId_subject: { subject: string } } }) => (roles[where.teamId_subject.subject] ? { role: roles[where.teamId_subject.subject] } : null) } } } as unknown as Database;
  const guard = new TeamMemberGuard(db, new Reflector());
  class Handlers { @RequireTeamRole('admin') write() {} read() {} }
  const req = (subject: string | undefined, path = '/api/v1/teams/t1/work-types') => {
    const r = { path, params: { teamId: 't1' } } as unknown as Request;
    if (subject) setIdentity(r, { subject });
    return r;
  };

  it('a team route needs a membership row: 403 without one, 401 without an identity', async () => {
    expect(await guard.canActivate(context(req('member'), { handler: Handlers.prototype.read }))).toBe(true);
    await expect(guard.canActivate(context(req('stranger'), { handler: Handlers.prototype.read }))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(context(req(undefined), { handler: Handlers.prototype.read }))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('@RequireTeamRole(\'admin\') admits an admin and refuses a member', async () => {
    expect(await guard.canActivate(context(req('admin'), { handler: Handlers.prototype.write }))).toBe(true);
    await expect(guard.canActivate(context(req('member'), { handler: Handlers.prototype.write }))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('routes without :teamId, paths outside /api/v1 and non-HTTP contexts pass', async () => {
    expect(await guard.canActivate(context({ path: '/api/v1/teams', params: {} } as unknown as Request))).toBe(true);
    expect(await guard.canActivate(context(req(undefined, '/somewhere')))).toBe(true);
    expect(await guard.canActivate(context({}, { type: 'rpc' }))).toBe(true);
  });
});

describe('SessionsService', () => {
  const notFound = new Prisma.PrismaClientKnownRequestError('not found', { code: 'P2025', clientVersion: 'x' });

  function service(rows: { login?: LoginAttempt | Error; session?: Session | null } = {}) {
    const calls: { deleted: unknown[]; created: unknown[]; purged: unknown[]; upserted: unknown[] } = { deleted: [], created: [], purged: [], upserted: [] };
    const db = {
      client: {
        $executeRaw: async (sql: TemplateStringsArray) => {
          const text = sql.join('?').replace(/\s+/g, ' ').trim();
          const table = /^DELETE FROM "(\w+)"/.exec(text)?.[1];
          calls.purged.push([table, text]);
          return table === 'Identity' ? 6 : 5;
        },
        loginAttempt: {
          create: async (args: unknown) => calls.created.push(args),
          deleteMany: async (args: unknown) => { calls.purged.push(['LoginAttempt', args]); return { count: 3 }; },
          delete: async () => { if (rows.login instanceof Error) throw rows.login; if (!rows.login) throw notFound; return rows.login; },
        },
        loginRateWindow: {
          deleteMany: async (args: unknown) => { calls.purged.push(['LoginRateWindow', args]); return { count: 4 }; },
        },
        identity: {
          upsert: async (args: unknown) => { calls.upserted.push(args); return args; },
        },
        $transaction: async (writes: Promise<unknown>[]) => Promise.all(writes),
        session: {
          create: async ({ data }: { data: Session }) => data,
          findUnique: async () => rows.session ?? null,
          deleteMany: async (args: unknown) => { calls.deleted.push(args); return { count: 2 }; },
        },
      },
    } as unknown as Database;
    return { sessions: new SessionsService(db), calls };
  }

  it('newLogin gives distinct random values and the S256 challenge of its verifier', () => {
    const { sessions } = service();
    const login = sessions.newLogin();
    expect(new Set([login.token, login.state, login.nonce, login.codeVerifier]).size).toBe(4);
    expect(login.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(login.codeChallenge).toBe(codeChallengeFor(login.codeVerifier));
    expect(login.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('saveLogin stores the hash of the token with a 10-minute expiry', async () => {
    const { sessions, calls } = service();
    const now = new Date('2026-10-21T12:00:00Z');
    await sessions.saveLogin({ token: 't', state: 's', nonce: 'n', codeVerifier: 'v', codeChallenge: 'c' }, now);
    expect(calls.created).toEqual([{ data: { id: hashToken('t'), state: 's', nonce: 'n', codeVerifier: 'v', expiresAt: new Date('2026-10-21T12:10:00Z') } }]);
  });

  it('takeLogin returns an unexpired sign-in once; an expired, missing or oversized one is null; other errors rethrow', async () => {
    expect(await service({ login: LOGIN }).sessions.takeLogin('t')).toEqual(LOGIN);
    expect(await service({ login: { ...LOGIN, expiresAt: new Date(Date.now() - 1) } }).sessions.takeLogin('t')).toBeNull();
    expect(await service().sessions.takeLogin('t')).toBeNull();
    expect(await service({ login: LOGIN }).sessions.takeLogin('x'.repeat(129))).toBeNull();
    await expect(service({ login: new Error('db down') }).sessions.takeLogin('t')).rejects.toThrow('db down');
  });

  it('create stores the hash, a CSRF token and an 8-hour absolute expiry', async () => {
    const now = new Date('2026-10-21T12:00:00Z');
    const { token, session } = await service().sessions.create({ subject: 's', email: 'e' }, now);
    expect(session).toMatchObject({ id: hashToken(token), subject: 's', email: 'e', displayName: null, expiresAt: new Date('2026-10-21T20:00:00Z') });
    expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await service().sessions.create({ subject: 's', email: 'e', displayName: 'S' })).session.displayName).toBe('S');
  });

  it('create upserts the Identity with the same email and display name, null when none was asserted (GWP#99)', async () => {
    const { sessions, calls } = service();
    await sessions.create({ subject: 's', email: 'e', displayName: 'S' });
    await sessions.create({ subject: 's', email: 'e2' });
    expect(calls.upserted).toEqual([
      { where: { subject: 's' }, create: { subject: 's', email: 'e', displayName: 'S' }, update: { email: 'e', displayName: 'S' } },
      { where: { subject: 's' }, create: { subject: 's', email: 'e2', displayName: null }, update: { email: 'e2', displayName: null } },
    ]);
  });

  it('find returns an unexpired session, deletes an expired one, and ignores missing or oversized tokens', async () => {
    const live = { id: 'h', expiresAt: new Date(Date.now() + 60_000) } as Session;
    expect(await service({ session: live }).sessions.find('t')).toBe(live);
    const expired = service({ session: { ...live, expiresAt: new Date(Date.now() - 1) } });
    expect(await expired.sessions.find('t')).toBeNull();
    expect(expired.calls.deleted).toEqual([{ where: { id: 'h' } }]);
    expect(await service().sessions.find('t')).toBeNull();
    expect(await service({ session: live }).sessions.find('x'.repeat(129))).toBeNull();
  });

  it('deleteForSubject removes every session of one subject in one deleteMany and says how many (GWP#56)', async () => {
    const { sessions, calls } = service();
    expect(await sessions.deleteForSubject('sub-1')).toBe(2);
    expect(calls.deleted).toEqual([{ where: { subject: 'sub-1' } }]);
  });

  it('delete removes the row behind the token, and ignores an oversized one', async () => {
    const { sessions, calls } = service();
    await sessions.delete('t');
    await sessions.delete('x'.repeat(129));
    expect(calls.deleted).toEqual([{ where: { id: hashToken('t') } }]);
  });

  it('purgeExpired deletes every sign-in and session at or past expiresAt, ended rate and quota windows, and Identity rows past the retention rule, and counts them (GWP#16, GWP#32, GWP#50, GWP#143)', async () => {
    const { sessions, calls } = service();
    const now = new Date('2026-10-23T12:00:00Z');
    expect(await sessions.purgeExpired(now)).toEqual({ loginAttempts: 3, sessions: 2, loginRateWindows: 4, quotaWindows: 5, identities: 6 });
    expect(IDENTITY_RETENTION_MS).toBe(90 * 24 * 3_600_000);
    expect(calls.purged).toEqual([
      ['LoginAttempt', { where: { expiresAt: { lte: now } } }],
      ['LoginRateWindow', { where: { windowStart: { lte: new Date('2026-10-23T11:59:00Z') } } }],
      ['QuotaWindow', expect.stringMatching(/^DELETE FROM "QuotaWindow" WHERE .*"windowStart" \+ "windowMs" \* interval '1 millisecond' <= /)],
      ['Identity', expect.stringMatching(/^DELETE FROM "Identity" .*"updatedAt" <= .*NOT EXISTS \(SELECT 1 FROM "TeamMember" .*NOT EXISTS \(SELECT 1 FROM "Session" .*"expiresAt" > /)],
    ]);
    expect(calls.deleted).toEqual([{ where: { expiresAt: { lte: now } } }]);
  });

  it('sameSecret compares in constant time and treats different lengths as unequal', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('abc', 'abcd')).toBe(false);
  });
});

describe('readCookie', () => {
  it('finds a cookie among others, and is undefined when absent or empty', () => {
    const req = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } });
    expect(readCookie(req('a=1; __Host-gwd_session=tok; b=2'), '__Host-gwd_session')).toBe('tok');
    expect(readCookie(req('xgwd_session=1; junk'), '__Host-gwd_session')).toBeUndefined();
    expect(readCookie(req('__Host-gwd_session='), '__Host-gwd_session')).toBeUndefined();
    expect(readCookie(req(), '__Host-gwd_session')).toBeUndefined();
  });
});

describe('FakeIdentityProvider', () => {
  it('returns the identity for a code it issued, once, with the right nonce and verifier', async () => {
    const fake = new FakeIdentityProvider();
    const verifier = 'v'.repeat(43);
    fake.signInAs({ subject: 'x', email: 'x@example.test' });
    const code = () => fake.authorizationUrl({ state: 's', nonce: 'n', codeChallenge: codeChallengeFor(verifier) }).then((url) => new URLSearchParams(url.split('?')[1]).get('code')!);
    const c1 = await code();
    expect(await fake.exchangeCode({ code: c1, nonce: 'n', codeVerifier: verifier })).toEqual({ subject: 'x', email: 'x@example.test' });
    await expect(fake.exchangeCode({ code: c1, nonce: 'n', codeVerifier: verifier })).rejects.toMatchObject({ reason: 'token_exchange_failed' });
    await expect(fake.exchangeCode({ code: await code(), nonce: 'n', codeVerifier: 'w'.repeat(43) })).rejects.toMatchObject({ reason: 'token_exchange_failed' });
    await expect(fake.exchangeCode({ code: await code(), nonce: 'other', codeVerifier: verifier })).rejects.toMatchObject({ reason: 'nonce_mismatch' });
  });
});

describe('login rate limit (GWP#16, GWP#32)', () => {
  const MINUTE = 60_000;

  /** The Postgres store's semantics in memory: a fixed window per key from its first take. */
  function memoryStore(): LoginRateStore {
    const windows = new Map<string, { windowStart: Date; count: number }>();
    return {
      async take(key, now, windowMs) {
        const held = windows.get(key);
        const window = held && now.getTime() - held.windowStart.getTime() < windowMs ? { ...held, count: held.count + 1 } : { windowStart: now, count: 1 };
        windows.set(key, window);
        return window;
      },
    };
  }

  function guardAt(clock: { t: number }, limit = 20, store = memoryStore()) {
    return new LoginRateLimitGuard(new RateLimiter({ store, limit, windowMs: MINUTE, now: () => clock.t }));
  }

  function loginContext(ip: string | undefined) {
    const setHeader = vi.fn();
    const ctx = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ ip, socket: { remoteAddress: ip } }), getResponse: () => ({ setHeader }) }) } as unknown as ExecutionContext;
    return { ctx, setHeader };
  }

  it('the 21st GET /auth/login in a minute from one address answers 429 with Retry-After', async () => {
    const clock = { t: 1_000_000 };
    const guard = guardAt(clock);
    for (let n = 1; n <= 20; n += 1) expect(await guard.canActivate(loginContext('203.0.113.7').ctx), `call ${n}`).toBe(true);
    clock.t += 15_000;
    const { ctx, setHeader } = loginContext('203.0.113.7');
    const thrown = await guard.canActivate(ctx).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(429);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '45');
  });

  it('another address keeps its own count, and the window resets a minute after its first call', async () => {
    const clock = { t: 0 };
    const guard = guardAt(clock, 2);
    expect(await guard.canActivate(loginContext('203.0.113.7').ctx)).toBe(true);
    expect(await guard.canActivate(loginContext('203.0.113.7').ctx)).toBe(true);
    await expect(guard.canActivate(loginContext('203.0.113.7').ctx)).rejects.toThrow(HttpException);
    expect(await guard.canActivate(loginContext('198.51.100.1').ctx)).toBe(true);
    clock.t = MINUTE - 1;
    await expect(guard.canActivate(loginContext('203.0.113.7').ctx)).rejects.toThrow(HttpException);
    clock.t = MINUTE;
    expect(await guard.canActivate(loginContext('203.0.113.7').ctx)).toBe(true);
  });

  it('non-HTTP contexts pass; a request with no address counts under one shared key', async () => {
    const guard = guardAt({ t: 0 }, 1);
    expect(await guard.canActivate({ getType: () => 'rpc' } as unknown as ExecutionContext)).toBe(true);
    expect(await guard.canActivate(loginContext(undefined).ctx)).toBe(true);
    await expect(guard.canActivate(loginContext(undefined).ctx)).rejects.toThrow(HttpException);
  });

  it('the guard answers 503 when the store throws, rather than skipping the limit', async () => {
    const store: LoginRateStore = { take: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const { ctx, setHeader } = loginContext('203.0.113.7');
    const thrown = await guardAt({ t: 0 }, 20, store).canActivate(ctx).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    expect(setHeader).not.toHaveBeenCalled();
    expect(store.take).toHaveBeenCalledWith('203.0.113.7', new Date(0), MINUTE);
  });

  it('Retry-After is the seconds left in the window, at least 1 and at most the window', () => {
    const over = { windowStart: new Date(0), count: 3 };
    expect(rateVerdict({ windowStart: new Date(0), count: 2 }, { limit: 2, windowMs: MINUTE, now: 0 })).toEqual({ allowed: true });
    expect(rateVerdict(over, { limit: 2, windowMs: MINUTE, now: 59_999 })).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(rateVerdict(over, { limit: 2, windowMs: MINUTE, now: 0 })).toEqual({ allowed: false, retryAfterSeconds: 60 });
    // Another task's clock ahead of this one's may start a window "in the future"; the wait stays a minute.
    expect(rateVerdict(over, { limit: 2, windowMs: MINUTE, now: -30_000 })).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('clientKey keeps IPv4 addresses whole, unwraps IPv4-mapped IPv6, and groups IPv6 by its /64', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:DB8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
    expect(clientKey(undefined)).toBe('unknown');
    expect(clientKey('')).toBe('unknown');
  });

  it('LOGIN_RATE_LIMIT sets the per-minute limit; 20 when unset or not a positive whole number', () => {
    expect(loginRateLimitFromEnv({})).toBe(20);
    expect(loginRateLimitFromEnv({ LOGIN_RATE_LIMIT: '5' })).toBe(5);
    for (const bad of ['0', '-1', '2.5', 'many', '']) expect(loginRateLimitFromEnv({ LOGIN_RATE_LIMIT: bad }), bad).toBe(20);
    expect(typeof LOGIN_RATE_LIMIT).toBe('symbol');
  });

  it('TRUST_PROXY_HOPS is how many proxies (the ALB) to trust for the client address: none by default; anything else stops startup', () => {
    expect(trustProxyHops({})).toBe(0);
    expect(trustProxyHops({ TRUST_PROXY_HOPS: '' })).toBe(0);
    expect(trustProxyHops({ TRUST_PROXY_HOPS: '1' })).toBe(1);
    for (const bad of ['-1', '1.5', 'true', 'loopback']) expect(() => trustProxyHops({ TRUST_PROXY_HOPS: bad }), bad).toThrow(/TRUST_PROXY_HOPS/);
  });
});

import { BadRequestException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { CreateTeamRequest } from '@getworkdone/contracts';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import type { Session } from '@getworkdone/db';
import { DenyByDefaultGuard, isProtectedPath } from '../src/common/deny-by-default.guard.js';
import { identityOf, requireIdentity, sessionOf, setIdentity } from '../src/common/identity.js';
import type { SessionsService } from '../src/modules/auth/sessions.service.js';
import { parseBody } from '../src/common/zod.js';

function httpContext(req: Partial<Request>, type = 'http'): ExecutionContext {
  return { getType: () => type, switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

const SESSION: Session = { id: 'hash', subject: 'carol', email: 'carol@example.test', displayName: null, csrfToken: 'csrf', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) };

/** Sessions where only the token 'good' names a session. */
const sessions = { find: async (token: string) => (token === 'good' ? SESSION : null) } as unknown as SessionsService;

describe('DenyByDefaultGuard', () => {
  const guard = new DenyByDefaultGuard(sessions);

  it('/api/v1 and everything under it is protected; /api/v10, /api/red, /healthz and the SPA are not', () => {
    for (const path of ['/api/v1', '/api/v1/', '/api/v1/teams', '/API/V1/teams/x']) expect(isProtectedPath(path), path).toBe(true);
    for (const path of ['/api/v10', '/api/red/boom', '/healthz', '/', '/teams/x']) expect(isProtectedPath(path), path).toBe(false);
  });

  it('repeated leading slashes do not take a path out of /api/v1 (GWP#15)', () => {
    for (const path of ['//api/v1/teams', '///api/v1', '//API/v1/me']) expect(isProtectedPath(path), path).toBe(true);
    for (const path of ['//api/v10', '//', '//teams/x']) expect(isProtectedPath(path), path).toBe(false);
  });

  it('encoded, dot-segment and backslash spellings do not take a path out of /api/v1 (GWP#30)', () => {
    for (const path of ['/%2Fapi/v1/me', '/%2fapi/v1/me', '/api%2Fv1/me', '/%61pi/v1/me', '/./api/v1/me', '/x/../api/v1/me', '/\\api/v1/me', '/%5Capi/v1', '/x/%2e%2e/api/v1']) expect(isProtectedPath(path), path).toBe(true);
    for (const path of ['/%2Fapi/v10', '/x/../api/v10', '/%2Fteams/x', '/x/../healthz']) expect(isProtectedPath(path), path).toBe(false);
  });

  it('a path under /api/v1 as sent stays protected even when its resolved form leaves it, and a malformed escape fails closed (GWP#30)', () => {
    for (const path of ['/api/v1/teams/a%2F..%2F..%2F..%2Fhealthz', '/api/v1/../../healthz', '/healthz%zz']) expect(isProtectedPath(path), path).toBe(true);
  });

  it('throws 401 for a protected path without an identity, and admits one with an identity', async () => {
    await expect(guard.canActivate(httpContext({ path: '/api/v1/teams', headers: {} }))).rejects.toThrow(UnauthorizedException);
    const req = { path: '/api/v1/teams', headers: {} } as Request;
    setIdentity(req, { subject: 'alice' });
    expect(await guard.canActivate(httpContext(req))).toBe(true);
  });

  it('stamps the identity and session from a __Host-gwd_session cookie that names a session (GWP#3)', async () => {
    const req = { path: '/api/v1/teams', headers: { cookie: 'other=1; __Host-gwd_session=good' } } as Request;
    expect(await guard.canActivate(httpContext(req))).toBe(true);
    expect(identityOf(req)).toEqual({ subject: 'carol', email: 'carol@example.test' });
    expect(sessionOf(req)).toEqual({ id: 'hash', csrfToken: 'csrf' });
  });

  it('a cookie that names no session is 401 on /api/v1 and leaves open paths open', async () => {
    await expect(guard.canActivate(httpContext({ path: '/api/v1/me', headers: { cookie: '__Host-gwd_session=stale' } }))).rejects.toThrow(UnauthorizedException);
    const open = { path: '/', headers: { cookie: '__Host-gwd_session=stale' } } as Request;
    expect(await guard.canActivate(httpContext(open))).toBe(true);
    expect(identityOf(open)).toBeUndefined();
  });

  it('admits open paths without an identity, and leaves non-HTTP contexts alone', async () => {
    expect(await guard.canActivate(httpContext({ path: '/healthz', headers: {} }))).toBe(true);
    expect(await guard.canActivate(httpContext({ path: '/api/v1/teams' }, 'rpc'))).toBe(true);
  });
});

describe('identity', () => {
  it('is absent until set, and requireIdentity is a 401 without one', () => {
    const req = {} as Request;
    expect(identityOf(req)).toBeUndefined();
    expect(() => requireIdentity(req)).toThrow(UnauthorizedException);
    setIdentity(req, { subject: 'bob' });
    expect(requireIdentity(req)).toEqual({ subject: 'bob' });
  });
});

describe('parseBody', () => {
  it('returns the parsed body, or a 400 naming each issue\'s path', () => {
    expect(parseBody(CreateTeamRequest, { name: 'Ops' })).toEqual({ name: 'Ops' });
    try {
      parseBody(CreateTeamRequest, { name: '' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({ issues: [{ path: 'name' }] });
    }
  });
});

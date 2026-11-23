// Deny by default (GWP#2), now admitting signed-in requests (GWP#3). It runs first of the global guards
// (common.module.ts): it reads the `__Host-gwd_session` cookie on any request, and when the cookie names an
// unexpired Session row it stamps the identity and the session on the request (identity.ts). Then every
// /api/v1 route without an identity answers 401. It is a global guard, so a route added later is
// covered without opting in. A GET of an unknown /api/v1 path reaches the SPA route and is a 401 too;
// other methods on unknown paths never reach a route, so Nest answers them 404 before any guard runs.
// /healthz, /auth and the SPA stay open. A repeated leading slash (//api/v1/me, GWP#15), a percent-escape,
// a dot segment or a backslash (/%2Fapi/v1/me, /./api/v1/me, /\api/v1/me, GWP#30) is still /api/v1.

import { Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { readCookie, SESSION_COOKIE } from '../modules/auth/cookies.js';
import { SessionsService } from '../modules/auth/sessions.service.js';
import { identityOf, setIdentity } from './identity.js';
import { matchesPath } from './path.js';

/** True for /api/v1 and anything under it, as sent or once resolved (matchesPath). */
export function isProtectedPath(path: string): boolean {
  return matchesPath(/^\/api\/v1(?:\/|$)/i, path);
}

@Injectable()
export class DenyByDefaultGuard implements CanActivate {
  constructor(private readonly sessions: SessionsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const token = readCookie(req, SESSION_COOKIE);
    if (token && !identityOf(req)) {
      const session = await this.sessions.find(token);
      if (session) {
        setIdentity(req, { subject: session.subject, email: session.email, ...(session.displayName ? { displayName: session.displayName } : {}) }, { id: session.id, csrfToken: session.csrfToken });
      }
    }
    if (isProtectedPath(req.path) && !identityOf(req)) throw new UnauthorizedException();
    return true;
  }
}

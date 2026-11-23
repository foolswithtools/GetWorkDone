// CSRF (GWP#3): a state-changing request (any method but GET, HEAD and OPTIONS) that carries a session
// must send the session's token in the X-GWD-CSRF header, or it is 403. The SPA reads the token from
// GET /api/v1/me. A request with no session has no ambient credential to abuse, so it is left to the
// deny-by-default guard (401 on /api/v1), which runs before this one (common.module.ts).

import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { sameSecret } from '../modules/auth/sessions.service.js';
import { sessionOf } from './identity.js';

export const CSRF_HEADER = 'x-gwd-csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const session = sessionOf(req);
    if (!session || SAFE_METHODS.has(req.method.toUpperCase())) return true;
    const header = req.headers[CSRF_HEADER];
    if (typeof header !== 'string' || !sameSecret(header, session.csrfToken)) throw new ForbiddenException('Missing or invalid X-GWD-CSRF header');
    return true;
  }
}

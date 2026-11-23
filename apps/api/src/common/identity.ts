// The verified identity on a request. The deny-by-default guard (deny-by-default.guard.ts) reads the
// `__Host-gwd_session` cookie, finds its unexpired Session row (GWP#3) and stamps the identity and the session
// with setIdentity before any route runs; a request without one is 401 on every /api/v1 route.

import { createParamDecorator, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface Identity {
  /** The identity provider's subject (`sub`); TeamMember.subject holds the same value. */
  subject: string;
  email?: string;
  displayName?: string;
}

/** The signed-in session behind an identity: its row id (a hash) and its CSRF token. */
export interface RequestSession {
  id: string;
  csrfToken: string;
}

const IDENTITY = Symbol('identity');
const SESSION = Symbol('session');

type WithIdentity = Request & { [IDENTITY]?: Identity; [SESSION]?: RequestSession };

export function setIdentity(req: Request, identity: Identity, session?: RequestSession): void {
  (req as WithIdentity)[IDENTITY] = identity;
  if (session) (req as WithIdentity)[SESSION] = session;
}

export function identityOf(req: Request): Identity | undefined {
  return (req as WithIdentity)[IDENTITY];
}

export function sessionOf(req: Request): RequestSession | undefined {
  return (req as WithIdentity)[SESSION];
}

/** The request's identity, for handlers behind the guard; a handler never runs without one. */
export function requireIdentity(req: Request): Identity {
  const identity = identityOf(req);
  if (!identity) throw new UnauthorizedException();
  return identity;
}

export const CurrentIdentity = createParamDecorator((_data: unknown, ctx: ExecutionContext): Identity => requireIdentity(ctx.switchToHttp().getRequest<Request>()));

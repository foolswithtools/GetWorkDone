// The two sign-in cookies (GWP#3, docs/auth.md). Both hold a random token whose SHA-256 is the row id.
//
//   __Host-gwd_session  the session: HttpOnly, Secure, SameSite=Lax, Path=/, 8-hour absolute expiry.
//   __Host-gwd_login    a sign-in in flight: the same flags, 10 minutes. SameSite=Lax still sends it
//                       on the issuer's top-level redirect back to /auth/callback.
//
// The __Host- prefix (GWP#17, D-087): a browser keeps such a cookie only if it is Secure, Path=/ and has
// no Domain, so a sibling host cannot set one on a parent domain to force a sign-in or shadow a session.
// That is why the login cookie is Path=/, not /auth. Set no Domain on either.

import type { CookieOptions, Request } from 'express';

export const SESSION_COOKIE = '__Host-gwd_session';
export const LOGIN_COOKIE = '__Host-gwd_login';

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const LOGIN_TTL_MS = 10 * 60 * 1000;

const BASE: CookieOptions = { httpOnly: true, secure: true, sameSite: 'lax' };

export const SESSION_COOKIE_OPTIONS: CookieOptions = { ...BASE, path: '/' };
export const LOGIN_COOKIE_OPTIONS: CookieOptions = { ...BASE, path: '/' };

/** The value of cookie `name` on the request, or undefined. No cookie-parser: one header, read here. */
export function readCookie(req: Pick<Request, 'headers'>, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1 || part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    return value || undefined;
  }
  return undefined;
}

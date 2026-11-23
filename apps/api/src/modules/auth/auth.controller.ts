// Sign-in routes (GWP#3, docs/auth.md). /auth is outside /api/v1, so the deny-by-default guard leaves
// it open; POST /auth/logout and /auth/logout/all are still CSRF-checked when they carry a session
// (csrf.guard.ts).
//
//   GET  /auth/login     new state, nonce and PKCE verifier (saved behind __Host-gwd_login), 302 to the issuer;
//                        429 past LOGIN_RATE_LIMIT a minute from one address, counted across every
//                        task in Postgres, and 503 if the count cannot be read (login-rate-limit.ts,
//                        GWP#16, GWP#32)
//   GET  /auth/callback  the __Host-gwd_login sign-in is used once; state checked, then the code exchanged
//                        and verified by the provider; the session the browser presents, if any, is
//                        deleted whoever it belonged to (GWP#56), a new __Host-gwd_session is set and the
//                        browser goes to /
//   POST /auth/logout    the session row is deleted and __Host-gwd_session cleared; 204
//   POST /auth/logout/all  every session of the signed-in subject is deleted and __Host-gwd_session
//                        cleared; 204, or 401 without a session (GWP#56)

import { BadRequestException, Controller, Get, HttpCode, Inject, Post, Query, Redirect, Req, Res, ServiceUnavailableException, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { identityOf } from '../../common/identity.js';
import { apiLogger } from '../../common/logger.js';
import { IDENTITY_PROVIDER, IdentityError, type IdentityProvider } from '../identity/identity.js';
import { LOGIN_COOKIE, LOGIN_COOKIE_OPTIONS, LOGIN_TTL_MS, SESSION_COOKIE, SESSION_COOKIE_OPTIONS, SESSION_TTL_MS, readCookie } from './cookies.js';
import { LoginRateLimitGuard } from './login-rate-limit.js';
import { SessionsService, sameSecret } from './sessions.service.js';

type CallbackQuery = Partial<Record<'code' | 'state' | 'error', unknown>>;

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

@Controller('auth')
export class AuthController {
  constructor(
    private readonly sessions: SessionsService,
    @Inject(IDENTITY_PROVIDER) private readonly provider: IdentityProvider | null,
  ) {}

  private requireProvider(): IdentityProvider {
    if (!this.provider) throw new ServiceUnavailableException('Sign-in is not configured (set OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_REDIRECT_URI)');
    return this.provider;
  }

  @Get('login')
  @UseGuards(LoginRateLimitGuard)
  @Redirect()
  async login(@Res({ passthrough: true }) res: Response): Promise<{ url: string; statusCode: number }> {
    const provider = this.requireProvider();
    const login = this.sessions.newLogin();
    let url: string;
    try {
      url = await provider.authorizationUrl({ state: login.state, nonce: login.nonce, codeChallenge: login.codeChallenge });
    } catch (error) {
      if (!(error instanceof IdentityError)) throw error;
      apiLogger.warn({ provider: provider.name, reason: error.reason }, 'sign-in unavailable');
      throw new ServiceUnavailableException('The identity provider is unavailable');
    }
    await this.sessions.saveLogin(login);
    res.cookie(LOGIN_COOKIE, login.token, { ...LOGIN_COOKIE_OPTIONS, maxAge: LOGIN_TTL_MS });
    return { url, statusCode: 302 };
  }

  @Get('callback')
  @Redirect()
  async callback(@Query() query: CallbackQuery, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ url: string; statusCode: number }> {
    const provider = this.requireProvider();
    const token = readCookie(req, LOGIN_COOKIE);
    res.clearCookie(LOGIN_COOKIE, LOGIN_COOKIE_OPTIONS);
    const login = token ? await this.sessions.takeLogin(token) : null;
    if (!login) throw new BadRequestException('No sign-in in progress; start again at /auth/login');
    const state = text(query.state);
    if (!state || !sameSecret(state, login.state)) throw new BadRequestException('Sign-in state does not match');
    if (query.error !== undefined) throw new BadRequestException('The identity provider did not complete the sign-in');
    const code = text(query.code);
    if (!code) throw new BadRequestException('The callback has no code');
    let identity;
    try {
      identity = await provider.exchangeCode({ code, nonce: login.nonce, codeVerifier: login.codeVerifier });
    } catch (error) {
      if (!(error instanceof IdentityError)) throw error;
      apiLogger.warn({ provider: provider.name, reason: error.reason }, 'sign-in refused');
      throw new UnauthorizedException('Sign-in failed');
    }
    // GWP#56: a sign-in replaces the browser's session, so a shared browser keeps no earlier person's.
    const previous = readCookie(req, SESSION_COOKIE);
    if (previous) await this.sessions.delete(previous);
    const { token: sessionToken } = await this.sessions.create(identity);
    res.cookie(SESSION_COOKIE, sessionToken, { ...SESSION_COOKIE_OPTIONS, maxAge: SESSION_TTL_MS });
    apiLogger.info({ provider: provider.name, subject: identity.subject }, 'signed in');
    return { url: '/', statusCode: 302 };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await this.sessions.delete(token);
    res.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
  }

  /** Sign out everywhere (GWP#56). /auth is outside the deny-by-default 401, so the session is checked here. */
  @Post('logout/all')
  @HttpCode(204)
  async logoutAll(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const identity = identityOf(req);
    if (!identity) throw new UnauthorizedException();
    const deleted = await this.sessions.deleteForSubject(identity.subject);
    res.clearCookie(SESSION_COOKIE, SESSION_COOKIE_OPTIONS);
    apiLogger.info({ subject: identity.subject, sessions_deleted: deleted }, 'signed out everywhere');
  }
}

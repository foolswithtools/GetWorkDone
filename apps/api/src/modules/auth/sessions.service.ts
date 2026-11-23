// Sessions and sign-ins in flight, in Postgres (GWP#3). A cookie holds a random 256-bit token; the row
// id is its SHA-256, so the table never holds a usable cookie. Session expiry is absolute: a session
// is never extended, and one past expiresAt is deleted when it is next presented, or by the periodic
// purge (session-purge.ts, GWP#16), whichever comes first. The same purge applies the Identity
// retention rule (GWP#143, docs/auth.md "Team membership").

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, type LoginAttempt, type Session } from '@getworkdone/db';
import { Database } from '../database/database.js';
import type { VerifiedIdentity } from '../identity/identity.js';
import { LOGIN_TTL_MS, SESSION_TTL_MS } from './cookies.js';
import { SHORTEST_QUOTA_WINDOW_MS } from '../../common/quota.js';
import { LOGIN_RATE_WINDOW_MS } from './login-rate-limit.js';

/** A random token: 32 bytes, base64url. */
export const newToken = () => randomBytes(32).toString('base64url');

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** The PKCE S256 challenge for a verifier (RFC 7636 4.2). */
export const codeChallengeFor = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** Constant-time string equality; strings of different lengths are unequal. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * How long an Identity (GWP#99) outlives its subject's last sign-in once the subject is in no team and has no
 * unexpired session: 90 days after updatedAt (GWP#143). A sign-in refreshes updatedAt, so a live session keeps
 * it anyway; the session condition only matters if this were ever shorter than a session.
 */
export const IDENTITY_RETENTION_MS = 90 * 24 * 60 * 60_000;

/** Longer than any token this service issues; a longer cookie is not looked up. */
const MAX_TOKEN_LENGTH = 128;

export interface PendingLogin { token: string; state: string; nonce: string; codeVerifier: string; codeChallenge: string }

@Injectable()
export class SessionsService {
  constructor(private readonly db: Database) {}

  /** Fresh state, nonce and PKCE verifier for a sign-in; nothing is stored until saveLogin. */
  newLogin(): PendingLogin {
    const codeVerifier = newToken();
    return { token: newToken(), state: newToken(), nonce: newToken(), codeVerifier, codeChallenge: codeChallengeFor(codeVerifier) };
  }

  async saveLogin(login: PendingLogin, now = new Date()): Promise<void> {
    await this.db.client.loginAttempt.create({
      data: { id: hashToken(login.token), state: login.state, nonce: login.nonce, codeVerifier: login.codeVerifier, expiresAt: new Date(now.getTime() + LOGIN_TTL_MS) },
    });
  }

  /** The sign-in behind a __Host-gwd_login token, deleted as it is read (single use); null if none or expired. */
  async takeLogin(token: string, now = new Date()): Promise<LoginAttempt | null> {
    if (token.length > MAX_TOKEN_LENGTH) return null;
    // One DELETE that returns the row: of two callbacks racing on the same cookie, only one gets it.
    const login = await this.db.client.loginAttempt.delete({ where: { id: hashToken(token) } }).catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return null;
      throw error;
    });
    return login && login.expiresAt > now ? login : null;
  }

  /**
   * A new session for a verified identity; the token goes in the cookie, the hash in the row. In the same
   * transaction the person's Identity (GWP#99) takes the email and display name this sign-in asserted, so
   * every team they are in shows them; the upsert's where and create name only the subject, so Prisma
   * runs it as one INSERT ... ON CONFLICT and two first sign-ins at once cannot collide.
   */
  async create(identity: VerifiedIdentity, now = new Date()): Promise<{ token: string; session: Session }> {
    const token = newToken();
    const profile = { email: identity.email, displayName: identity.displayName ?? null };
    const [, session] = await this.db.client.$transaction([
      this.db.client.identity.upsert({ where: { subject: identity.subject }, create: { subject: identity.subject, ...profile }, update: profile }),
      this.db.client.session.create({
        data: {
          id: hashToken(token), subject: identity.subject, ...profile,
          csrfToken: newToken(), expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
        },
      }),
    ]);
    return { token, session };
  }

  /** The unexpired session behind a __Host-gwd_session token; an expired row is deleted. */
  async find(token: string, now = new Date()): Promise<Session | null> {
    if (token.length > MAX_TOKEN_LENGTH) return null;
    const session = await this.db.client.session.findUnique({ where: { id: hashToken(token) } });
    if (!session) return null;
    if (session.expiresAt <= now) {
      await this.db.client.session.deleteMany({ where: { id: session.id } });
      return null;
    }
    return session;
  }

  /**
   * Deletes every sign-in and session at or past expiresAt (the expiry find and takeLogin apply), every
   * sign-in rate window that has ended (login-rate-limit.ts, GWP#32) and every quota window whose
   * windowStart + windowMs has passed (common/quota.ts, GWP#50), and every Identity whose updatedAt is
   * IDENTITY_RETENTION_MS old or more and whose subject has no TeamMember row and no unexpired Session
   * (GWP#143), using their indexes; resolves with how many rows went from each table.
   */
  async purgeExpired(now = new Date()): Promise<{ loginAttempts: number; sessions: number; loginRateWindows: number; quotaWindows: number; identities: number }> {
    const expired = { where: { expiresAt: { lte: now } } };
    const loginAttempts = await this.db.client.loginAttempt.deleteMany(expired);
    const loginRateWindows = await this.db.client.loginRateWindow.deleteMany({ where: { windowStart: { lte: new Date(now.getTime() - LOGIN_RATE_WINDOW_MS) } } });
    // Times as epoch milliseconds in UTC, as the quota store writes them; no window is shorter than the
    // shortest quota's, so the first condition lets the windowStart index narrow the scan.
    const at = (ms: number) => Prisma.sql`(to_timestamp(${ms}::float8 / 1000) AT TIME ZONE 'UTC')`;
    const quotaWindows = await this.db.client.$executeRaw`
      DELETE FROM "QuotaWindow" WHERE "windowStart" <= ${at(now.getTime() - SHORTEST_QUOTA_WINDOW_MS)}
        AND "windowStart" + "windowMs" * interval '1 millisecond' <= ${at(now.getTime())}`;
    const sessions = await this.db.client.session.deleteMany(expired);
    // A sign-in racing this delete either commits first, and its fresh updatedAt fails the first condition
    // when Postgres re-checks the row, or upserts after it and inserts the row again.
    const identities = await this.db.client.$executeRaw`
      DELETE FROM "Identity" AS i WHERE i."updatedAt" <= ${at(now.getTime() - IDENTITY_RETENTION_MS)}
        AND NOT EXISTS (SELECT 1 FROM "TeamMember" AS m WHERE m."subject" = i."subject")
        AND NOT EXISTS (SELECT 1 FROM "Session" AS s WHERE s."subject" = i."subject" AND s."expiresAt" > ${at(now.getTime())})`;
    return { loginAttempts: loginAttempts.count, sessions: sessions.count, loginRateWindows: loginRateWindows.count, quotaWindows, identities };
  }

  /** Logout: delete the row behind the token, if there is one. */
  async delete(token: string): Promise<void> {
    if (token.length > MAX_TOKEN_LENGTH) return;
    await this.db.client.session.deleteMany({ where: { id: hashToken(token) } });
  }

  /** Sign out everywhere (GWP#56): delete every session of one subject, through its index; how many went. */
  async deleteForSubject(subject: string): Promise<number> {
    return (await this.db.client.session.deleteMany({ where: { subject } })).count;
  }
}

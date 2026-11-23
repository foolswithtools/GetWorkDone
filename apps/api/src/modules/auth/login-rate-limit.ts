// The per-client limit on GET /auth/login (GWP#16, GWP#32, docs/auth.md). Each call writes a LoginAttempt
// row before anyone signs in, so one address may start LOGIN_RATE_LIMIT sign-ins a minute (default 20);
// beyond that the route answers 429 with Retry-After and writes nothing. The address is Express's
// req.ip: the socket peer, or with TRUST_PROXY_HOPS set (app.ts) the client the ALB saw. IPv6 clients
// count by their /64, which one host can fill with addresses. The count lives in Postgres
// (LoginRateWindow), so every API task shares it and a restart keeps it; if the database cannot be
// reached the route answers 503 rather than skip the limit. The session purge deletes ended windows.
import { HttpException, HttpStatus, Inject, Injectable, ServiceUnavailableException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { isIPv4, isIPv6 } from 'node:net';
import type { Request, Response } from 'express';
import { Prisma } from '@getworkdone/db';
import { apiLogger } from '../../common/logger.js';
import type { Database } from '../database/database.js';

export const LOGIN_RATE_LIMIT = Symbol('LOGIN_RATE_LIMIT');
export const DEFAULT_LOGIN_RATE_LIMIT = 20;
export const LOGIN_RATE_WINDOW_MS = 60_000;

/** Sign-ins one address may start a minute, from LOGIN_RATE_LIMIT; 20 unless it is a positive whole number. */
export function loginRateLimitFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const limit = Number(env.LOGIN_RATE_LIMIT);
  return env.LOGIN_RATE_LIMIT && Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LOGIN_RATE_LIMIT;
}

/** The key an address counts under: IPv4 as is (also when IPv4-mapped), IPv6 by its /64. */
export function clientKey(address: string | undefined): string {
  if (!address) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped && isIPv4(mapped)) return mapped;
  if (!isIPv6(address)) return address;
  const [head = '', tail = ''] = address.toLowerCase().split('::');
  const front = head ? head.split(':') : [];
  const back = address.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = [...front, ...Array<string>(8 - front.length - back.length).fill('0'), ...back];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** A key's window as the store holds it after a take: when it started and the takes in it, this one included. */
export interface RateWindow { windowStart: Date; count: number }

/** Where the windows live; every API task must share it. */
export interface LoginRateStore {
  /** Counts one take for `key` and returns its window; a window `windowMs` old or more starts again at `now`. */
  take(key: string, now: Date, windowMs: number): Promise<RateWindow>;
}

/**
 * The windows in Postgres. One INSERT ... ON CONFLICT DO UPDATE counts the take, so takes racing from
 * any number of tasks on one key are counted one by one under its row lock. Times cross as epoch
 * milliseconds and the column holds UTC, like Prisma's own writes, whatever the session time zone.
 */
export class PostgresLoginRateStore implements LoginRateStore {
  constructor(private readonly db: Database) {}

  async take(key: string, now: Date, windowMs: number): Promise<RateWindow> {
    const at = (ms: number) => Prisma.sql`(to_timestamp(${ms}::float8 / 1000) AT TIME ZONE 'UTC')`;
    const ended = Prisma.sql`"LoginRateWindow"."windowStart" <= ${at(now.getTime() - windowMs)}`;
    const [row] = await this.db.client.$queryRaw<{ startMs: number; count: number }[]>`
      INSERT INTO "LoginRateWindow" ("key", "windowStart", "count") VALUES (${key}, ${at(now.getTime())}, 1)
      ON CONFLICT ("key") DO UPDATE SET
        "windowStart" = CASE WHEN ${ended} THEN EXCLUDED."windowStart" ELSE "LoginRateWindow"."windowStart" END,
        "count" = CASE WHEN ${ended} THEN 1 ELSE "LoginRateWindow"."count" + 1 END
      RETURNING (extract(epoch FROM "windowStart") * 1000)::float8 AS "startMs", "count"`;
    if (!row) throw new Error('LoginRateWindow upsert returned no row');
    return { windowStart: new Date(Math.round(Number(row.startMs))), count: Number(row.count) };
  }
}

export type RateVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Whether a take is within `limit`; if not, the whole seconds until its window ends, from 1 to the window. */
export function rateVerdict(window: RateWindow, { limit, windowMs, now }: { limit: number; windowMs: number; now: number }): RateVerdict {
  if (window.count <= limit) return { allowed: true };
  const left = Math.ceil((window.windowStart.getTime() + windowMs - now) / 1000);
  return { allowed: false, retryAfterSeconds: Math.min(Math.max(1, left), Math.ceil(windowMs / 1000)) };
}

/** A fixed window per key: `limit` takes in the `windowMs` after a key's first take, counted in `store`. */
export class RateLimiter {
  private readonly store: LoginRateStore;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor({ store, limit, windowMs, now = Date.now }: { store: LoginRateStore; limit: number; windowMs: number; now?: () => number }) {
    this.store = store;
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  async take(key: string): Promise<RateVerdict> {
    const now = this.now();
    const window = await this.store.take(key, new Date(now), this.windowMs);
    return rateVerdict(window, { limit: this.limit, windowMs: this.windowMs, now });
  }
}

@Injectable()
export class LoginRateLimitGuard implements CanActivate {
  constructor(@Inject(LOGIN_RATE_LIMIT) private readonly limiter: RateLimiter) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const http = context.switchToHttp();
    const key = clientKey(http.getRequest<Request>().ip);
    let verdict: RateVerdict;
    try {
      verdict = await this.limiter.take(key);
    } catch (error) {
      // Without the shared count there is no limit to apply, and sign-in waits for it.
      apiLogger.error({ err: error }, 'sign-in rate limit store unavailable');
      throw new ServiceUnavailableException('Sign-in is unavailable; try again shortly');
    }
    if (verdict.allowed) return true;
    http.getResponse<Response>().setHeader('Retry-After', String(verdict.retryAfterSeconds));
    throw new HttpException('Too many sign-ins from this address; try again shortly', HttpStatus.TOO_MANY_REQUESTS);
  }
}

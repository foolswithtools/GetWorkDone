import { HttpException, ServiceUnavailableException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_QUOTAS, deferral, QUOTA_DEFERRED, QUOTA_WINDOWS, QuotaGuard, QuotaLimiter, quotaLimiter, quotasFromEnv, TakeQuota,
  type QuotaStore,
} from '../src/common/quota.js';
import { setIdentity } from '../src/common/identity.js';
import type { RateWindow } from '../src/modules/auth/login-rate-limit.js';
import type { Database } from '../src/modules/database/database.js';

// Partition `unit`: the quotas (GWP#50, docs/domain.md) with the store in memory and the clock injected;
// quotas.integration.test.ts runs them against Postgres through the routes and the worker.

const HOUR = 3_600_000;

/** The windows in memory, with PostgresQuotaStore's rule: a window `windowMs` old or more starts again. */
function memoryStore(): QuotaStore & { keys: string[] } {
  const windows = new Map<string, RateWindow>();
  const keys: string[] = [];
  return {
    keys,
    async take(key, now, windowMs) {
      keys.push(key);
      const current = windows.get(key);
      const window = current && now.getTime() - current.windowStart.getTime() < windowMs
        ? { windowStart: current.windowStart, count: current.count + 1 }
        : { windowStart: now, count: 1 };
      windows.set(key, window);
      return window;
    },
  };
}

describe('quotasFromEnv', () => {
  it('returns the five defaults for an empty environment', () => {
    expect(quotasFromEnv({})).toEqual({
      teamsPerSubjectPerDay: 5, workTypesPerTeam: 50, itemsPerSubjectPerMinute: 60, deliveriesPerTeamPerHour: 500, exportsPerTeamPerHour: 20,
    });
    expect(DEFAULT_QUOTAS).toEqual(quotasFromEnv({}));
  });

  it('parses whole numbers from the five variables', () => {
    expect(quotasFromEnv({
      QUOTA_TEAMS_PER_SUBJECT_PER_DAY: '7', QUOTA_WORK_TYPES_PER_TEAM: '8', QUOTA_ITEMS_PER_SUBJECT_PER_MINUTE: '500',
      QUOTA_DELIVERIES_PER_TEAM_PER_HOUR: '10', QUOTA_EXPORTS_PER_TEAM_PER_HOUR: '1',
    })).toEqual({ teamsPerSubjectPerDay: 7, workTypesPerTeam: 8, itemsPerSubjectPerMinute: 500, deliveriesPerTeamPerHour: 10, exportsPerTeamPerHour: 1 });
  });

  it('falls back to the default for 0, -1, abc, a fraction and an empty value: there is no "unlimited"', () => {
    for (const value of ['0', '-1', 'abc', '2.5', '']) {
      expect(quotasFromEnv({ QUOTA_ITEMS_PER_SUBJECT_PER_MINUTE: value }).itemsPerSubjectPerMinute, value).toBe(60);
    }
  });
});

describe('QuotaLimiter', () => {
  const at = (clock: { t: number }) => () => new Date(clock.t);

  it('allows the Nth take, refuses the N+1th with the whole seconds left in the window, and starts a new window after it', async () => {
    const clock = { t: 1_000_000 };
    const store = memoryStore();
    const limiter = new QuotaLimiter({ store, limits: { ...DEFAULT_QUOTAS, exportsPerTeamPerHour: 3 }, now: at(clock) });
    for (let n = 1; n <= 3; n += 1) expect(await limiter.take('exports', 'team-1'), `take ${n}`).toEqual({ allowed: true });
    clock.t += 10 * 60_000 + 500;
    expect(await limiter.take('exports', 'team-1')).toEqual({ allowed: false, retryAfterSeconds: 50 * 60, windowEnd: new Date(1_000_000 + HOUR) });
    expect(store.keys.at(-1)).toBe('exports:team-1');
    clock.t = 1_000_000 + HOUR;
    expect(await limiter.take('exports', 'team-1')).toEqual({ allowed: true });
  });

  it('keys each quota by its own prefix, so one id counts separately per quota', async () => {
    const store = memoryStore();
    const limiter = new QuotaLimiter({ store, limits: { ...DEFAULT_QUOTAS, teamsPerSubjectPerDay: 1, itemsPerSubjectPerMinute: 1 } });
    expect(await limiter.take('teams', 'alice')).toEqual({ allowed: true });
    expect(await limiter.take('items', 'alice')).toEqual({ allowed: true });
    expect((await limiter.take('items', 'alice')).allowed).toBe(false);
    expect(await limiter.take('items', 'bob')).toEqual({ allowed: true });
    expect(store.keys).toEqual(['teams:alice', 'items:alice', 'items:alice', 'items:bob']);
  });

  it('uses a day, a minute and an hour for its windows', () => {
    expect(QUOTA_WINDOWS.teams.windowMs).toBe(24 * HOUR);
    expect(QUOTA_WINDOWS.items.windowMs).toBe(60_000);
    expect(QUOTA_WINDOWS.deliveries.windowMs).toBe(HOUR);
    expect(QUOTA_WINDOWS.exports.windowMs).toBe(HOUR);
  });

  it('takes nothing and allows everything when not enforced, and has no work type cap', async () => {
    const store = memoryStore();
    const limiter = new QuotaLimiter({ store, limits: undefined });
    for (let n = 0; n < 100; n += 1) expect(await limiter.take('items', 'alice')).toEqual({ allowed: true });
    expect(store.keys).toEqual([]);
    expect(limiter.workTypeCap()).toBeUndefined();
    expect(new QuotaLimiter({ store, limits: { ...DEFAULT_QUOTAS, workTypesPerTeam: 2 } }).workTypeCap()).toBe(2);
  });
});

describe('quotaLimiter (the limiter the app provides)', () => {
  const db = {} as Database;

  it('under NODE_ENV=test with no explicit limits enforces nothing (the existing suites run unchanged)', async () => {
    const log = vi.fn();
    const limiter = quotaLimiter(db, undefined, { NODE_ENV: 'test' }, log);
    expect(limiter.limits).toBeUndefined();
    expect(await limiter.take('teams', 'alice')).toEqual({ allowed: true });
    expect(log).toHaveBeenCalledWith({ enforced: false, ...DEFAULT_QUOTAS, startup: true }, 'quotas');
  });

  it('under NODE_ENV=test with explicit limits enforces them over the defaults', () => {
    const log = vi.fn();
    const limiter = quotaLimiter(db, { limits: { teamsPerSubjectPerDay: 2 } }, { NODE_ENV: 'test', QUOTA_EXPORTS_PER_TEAM_PER_HOUR: '9' }, log);
    expect(limiter.limits).toEqual({ ...DEFAULT_QUOTAS, exportsPerTeamPerHour: 9, teamsPerSubjectPerDay: 2 });
    expect(log).toHaveBeenCalledWith({ enforced: true, ...DEFAULT_QUOTAS, exportsPerTeamPerHour: 9, teamsPerSubjectPerDay: 2, startup: true }, 'quotas');
  });

  it('outside tests enforces the environment\'s values, and the startup line shows the effective ones', () => {
    const log = vi.fn();
    const limiter = quotaLimiter(db, undefined, { NODE_ENV: 'production', QUOTA_TEAMS_PER_SUBJECT_PER_DAY: '3', QUOTA_WORK_TYPES_PER_TEAM: 'lots' }, log);
    expect(limiter.limits).toEqual({ ...DEFAULT_QUOTAS, teamsPerSubjectPerDay: 3 });
    expect(log).toHaveBeenCalledWith({ enforced: true, ...DEFAULT_QUOTAS, teamsPerSubjectPerDay: 3, startup: true }, 'quotas');
  });

  // GWP#134: with LOG_STDOUT_LEVEL at warn (GWP#58) an info line reaches only Loki; startup: true keeps it in CloudWatch.
  it('tags the quotas line startup: true, so it reaches stdout whatever LOG_STDOUT_LEVEL is', () => {
    const log = vi.fn();
    quotaLimiter(db, undefined, { NODE_ENV: 'production' }, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatchObject({ startup: true });
  });

  describe('its clock (GWP#74)', () => {
    // PostgresQuotaStore over a fake client: every take answers a window opened at START, already past a limit of 1.
    const START = 1_000_000;
    const windowAtStart = () => {
      const queryRaw = vi.fn(async () => [{ startMs: START, count: 2 }]);
      return { db: { client: { $queryRaw: queryRaw } } as unknown as Database, queryRaw };
    };
    const distributeNow = () => new Date(START + 10 * 60_000);

    it('given only a distribute clock, uses it for window ends: the refusal is timed from that clock', async () => {
      const { db: store } = windowAtStart();
      const limiter = quotaLimiter(store, { limits: { deliveriesPerTeamPerHour: 1 } }, { NODE_ENV: 'test' }, vi.fn(), distributeNow);
      expect(await limiter.take('deliveries', 'team-1')).toEqual({ allowed: false, retryAfterSeconds: 50 * 60, windowEnd: new Date(START + HOUR) });
    });

    it('prefers the quotas clock over the distribute clock', async () => {
      const { db: store } = windowAtStart();
      const limiter = quotaLimiter(store, { limits: { deliveriesPerTeamPerHour: 1 }, now: () => new Date(START + 40 * 60_000) }, { NODE_ENV: 'test' }, vi.fn(), distributeNow);
      expect(await limiter.take('deliveries', 'team-1')).toMatchObject({ allowed: false, retryAfterSeconds: 20 * 60 });
    });

    it('a distribute clock alone, under NODE_ENV=test, still enforces nothing and counts nothing', async () => {
      const { db: store, queryRaw } = windowAtStart();
      const limiter = quotaLimiter(store, undefined, { NODE_ENV: 'test' }, vi.fn(), distributeNow);
      expect(limiter.limits).toBeUndefined();
      expect(await limiter.take('deliveries', 'team-1')).toEqual({ allowed: true });
      expect(queryRaw).not.toHaveBeenCalled();
    });
  });
});

describe('deferral', () => {
  it('maps a refused delivery take to nextAttemptAt at the window\'s end and lastError quota_deferred', () => {
    const windowEnd = new Date('2026-10-30T13:00:00.000Z');
    expect(deferral({ allowed: false, retryAfterSeconds: 1200, windowEnd })).toEqual({ nextAttemptAt: windowEnd, lastError: QUOTA_DEFERRED });
    expect(QUOTA_DEFERRED).toBe('quota_deferred');
  });
});

describe('QuotaGuard', () => {
  class Routes {
    @TakeQuota('items') items() {}
    @TakeQuota('exports') exports() {}
    untaxed() {}
  }

  function contextFor(handler: () => void, req: object) {
    const setHeader = vi.fn();
    const ctx = {
      getType: () => 'http', getHandler: () => handler, getClass: () => Routes,
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader }) }),
    } as unknown as ExecutionContext;
    return { ctx, setHeader };
  }
  const signedIn = (subject: string, params: object = {}) => {
    const req = { params } as unknown as Request;
    setIdentity(req, { subject, email: `${subject}@example.test` });
    return req;
  };

  it('takes a subject\'s quota by subject and a team\'s by the :teamId parameter', async () => {
    const store = memoryStore();
    const guard = new QuotaGuard(new QuotaLimiter({ store, limits: DEFAULT_QUOTAS }), new Reflector());
    expect(await guard.canActivate(contextFor(Routes.prototype.items, signedIn('alice', { teamId: 't1' })).ctx)).toBe(true);
    expect(await guard.canActivate(contextFor(Routes.prototype.exports, signedIn('alice', { teamId: 't1' })).ctx)).toBe(true);
    expect(await guard.canActivate(contextFor(Routes.prototype.untaxed, signedIn('alice')).ctx)).toBe(true);
    expect(store.keys).toEqual(['items:alice', 'exports:t1']);
  });

  it('answers a refusal 429 with Retry-After in whole seconds and a one-line message', async () => {
    const clock = { t: 5_000_000 };
    const guard = new QuotaGuard(new QuotaLimiter({ store: memoryStore(), limits: { ...DEFAULT_QUOTAS, itemsPerSubjectPerMinute: 1 }, now: () => new Date(clock.t) }), new Reflector());
    await guard.canActivate(contextFor(Routes.prototype.items, signedIn('alice')).ctx);
    clock.t += 15_200;
    const { ctx, setHeader } = contextFor(Routes.prototype.items, signedIn('alice'));
    const thrown = await guard.canActivate(ctx).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(429);
    expect((thrown as HttpException).message).toMatch(/^[^\n]+$/);
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '45');
  });

  it('answers 503 when the store cannot be reached, rather than skip the quota', async () => {
    const store: QuotaStore = { take: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const guard = new QuotaGuard(new QuotaLimiter({ store, limits: DEFAULT_QUOTAS }), new Reflector());
    await expect(guard.canActivate(contextFor(Routes.prototype.items, signedIn('alice')).ctx)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('lets a request without a subject or team through to the guards that refuse it, and ignores non-HTTP contexts', async () => {
    const store = memoryStore();
    const guard = new QuotaGuard(new QuotaLimiter({ store, limits: DEFAULT_QUOTAS }), new Reflector());
    expect(await guard.canActivate(contextFor(Routes.prototype.items, { params: {} }).ctx)).toBe(true);
    expect(await guard.canActivate(contextFor(Routes.prototype.exports, signedIn('alice')).ctx)).toBe(true);
    expect(await guard.canActivate({ getType: () => 'rpc' } as unknown as ExecutionContext)).toBe(true);
    expect(store.keys).toEqual([]);
  });
});

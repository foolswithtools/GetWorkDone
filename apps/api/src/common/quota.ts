// Quotas (GWP#50, docs/domain.md): how much work one subject or one team may ask for. Four are fixed
// windows counted in Postgres (QuotaWindow), so every API task shares them and a restart keeps them:
// teams a subject creates a day, items a subject submits a minute, deliveries a team sends an hour and
// exports a team makes an hour. The fifth, active work types per team, is a cap counted under the team's
// row lock on create and on unarchive; archived ones do not count (work-types.service.ts, GWP#103). The routes take a quota with @TakeQuota, a guard that runs after
// authentication, CSRF and membership and before the body is read, so a refused request writes nothing
// and one that then fails validation has still counted: a quota bounds work, not successes. The worker
// takes `deliveries` before each attempt and defers a refused one (delivery.worker.ts). Admins are not
// exempt. The generalisation of the sign-in limit (login-rate-limit.ts), which keeps its own table.
import {
  applyDecorators, HttpException, HttpStatus, Inject, Injectable, SetMetadata, ServiceUnavailableException, UseGuards,
  type CanActivate, type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Prisma } from '@getworkdone/db';
import { rateVerdict, type RateWindow } from '../modules/auth/login-rate-limit.js';
import type { Database } from '../modules/database/database.js';
import { identityOf } from './identity.js';
import { apiLogger } from './logger.js';

export interface QuotaLimits {
  teamsPerSubjectPerDay: number;
  /** A cap, not a window: active (unarchived) work types one team may have at once (GWP#103). */
  workTypesPerTeam: number;
  itemsPerSubjectPerMinute: number;
  deliveriesPerTeamPerHour: number;
  exportsPerTeamPerHour: number;
}

export const DEFAULT_QUOTAS: QuotaLimits = { teamsPerSubjectPerDay: 5, workTypesPerTeam: 50, itemsPerSubjectPerMinute: 60, deliveriesPerTeamPerHour: 500, exportsPerTeamPerHour: 20 };

/** The variable each limit is read from. */
export const QUOTA_ENV: Record<keyof QuotaLimits, string> = {
  teamsPerSubjectPerDay: 'QUOTA_TEAMS_PER_SUBJECT_PER_DAY',
  workTypesPerTeam: 'QUOTA_WORK_TYPES_PER_TEAM',
  itemsPerSubjectPerMinute: 'QUOTA_ITEMS_PER_SUBJECT_PER_MINUTE',
  deliveriesPerTeamPerHour: 'QUOTA_DELIVERIES_PER_TEAM_PER_HOUR',
  exportsPerTeamPerHour: 'QUOTA_EXPORTS_PER_TEAM_PER_HOUR',
};

/** Each limit from its variable when that is a positive whole number, its default otherwise; there is no "unlimited". */
export function quotasFromEnv(env: NodeJS.ProcessEnv = process.env): QuotaLimits {
  const read = (name: keyof QuotaLimits) => {
    const raw = env[QUOTA_ENV[name]];
    return raw && /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : DEFAULT_QUOTAS[name];
  };
  return {
    teamsPerSubjectPerDay: read('teamsPerSubjectPerDay'), workTypesPerTeam: read('workTypesPerTeam'), itemsPerSubjectPerMinute: read('itemsPerSubjectPerMinute'),
    deliveriesPerTeamPerHour: read('deliveriesPerTeamPerHour'), exportsPerTeamPerHour: read('exportsPerTeamPerHour'),
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The windowed quotas: the limit each counts against, its window, what it is keyed by and its refusal. */
export const QUOTA_WINDOWS = {
  teams: { limit: 'teamsPerSubjectPerDay', windowMs: 24 * HOUR, by: 'subject', message: 'You have created as many teams as allowed today; try again later' },
  items: { limit: 'itemsPerSubjectPerMinute', windowMs: MINUTE, by: 'subject', message: 'You have submitted as many items as allowed this minute; try again shortly' },
  deliveries: { limit: 'deliveriesPerTeamPerHour', windowMs: HOUR, by: 'team', message: 'This team has sent as many deliveries as allowed this hour' },
  exports: { limit: 'exportsPerTeamPerHour', windowMs: HOUR, by: 'team', message: 'This team has made as many exports as allowed this hour; try again later' },
} as const satisfies Record<string, { limit: keyof QuotaLimits; windowMs: number; by: 'subject' | 'team'; message: string }>;

export type QuotaName = keyof typeof QUOTA_WINDOWS;

/** No window ends sooner after it starts than this; the purge uses it to narrow its scan (sessions.service.ts). */
export const SHORTEST_QUOTA_WINDOW_MS = Math.min(...Object.values(QUOTA_WINDOWS).map((w) => w.windowMs));

/** Where the windows live; every API task must share it. */
export interface QuotaStore {
  /** Counts one take for `key` and returns its window; a window `windowMs` old or more starts again at `now`. */
  take(key: string, now: Date, windowMs: number): Promise<RateWindow>;
}

/**
 * The windows in Postgres, as PostgresLoginRateStore does it: one INSERT ... ON CONFLICT DO UPDATE per
 * take, counted one by one under the key's row lock from any number of tasks. The row keeps its
 * window's length, so the purge can delete it once it ends whatever the quota.
 */
export class PostgresQuotaStore implements QuotaStore {
  constructor(private readonly db: Database) {}

  async take(key: string, now: Date, windowMs: number): Promise<RateWindow> {
    const at = (ms: number) => Prisma.sql`(to_timestamp(${ms}::float8 / 1000) AT TIME ZONE 'UTC')`;
    const ended = Prisma.sql`"QuotaWindow"."windowStart" <= ${at(now.getTime() - windowMs)}`;
    const [row] = await this.db.client.$queryRaw<{ startMs: number; count: number }[]>`
      INSERT INTO "QuotaWindow" ("key", "windowStart", "windowMs", "count") VALUES (${key}, ${at(now.getTime())}, ${windowMs}, 1)
      ON CONFLICT ("key") DO UPDATE SET
        "windowStart" = CASE WHEN ${ended} THEN EXCLUDED."windowStart" ELSE "QuotaWindow"."windowStart" END,
        "windowMs" = EXCLUDED."windowMs",
        "count" = CASE WHEN ${ended} THEN 1 ELSE "QuotaWindow"."count" + 1 END
      RETURNING (extract(epoch FROM "windowStart") * 1000)::float8 AS "startMs", "count"`;
    if (!row) throw new Error('QuotaWindow upsert returned no row');
    return { windowStart: new Date(Math.round(Number(row.startMs))), count: Number(row.count) };
  }
}

/** A take's answer; a refusal says when its window ends, as whole seconds from now and as a time. */
export type QuotaVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number; windowEnd: Date };

/** The quotas: `limits` undefined means none is enforced and nothing is counted. */
@Injectable()
export class QuotaLimiter {
  readonly limits: QuotaLimits | undefined;
  private readonly store: QuotaStore;
  private readonly now: () => Date;

  constructor({ store, limits, now = () => new Date() }: { store: QuotaStore; limits: QuotaLimits | undefined; now?: () => Date }) {
    this.store = store;
    this.limits = limits;
    this.now = now;
  }

  /** Counts one take of `quota` for `id` (a subject or a team id) and says whether it is within the limit. */
  async take(quota: QuotaName, id: string): Promise<QuotaVerdict> {
    if (!this.limits) return { allowed: true };
    const { limit, windowMs } = QUOTA_WINDOWS[quota];
    const now = this.now();
    const window = await this.store.take(`${quota}:${id}`, now, windowMs);
    const verdict = rateVerdict(window, { limit: this.limits[limit], windowMs, now: now.getTime() });
    return verdict.allowed ? verdict : { ...verdict, windowEnd: new Date(window.windowStart.getTime() + windowMs) };
  }

  /** Work types a team may have, or undefined when quotas are not enforced. */
  workTypeCap(): number | undefined {
    return this.limits?.workTypesPerTeam;
  }
}

/** Quotas for tests, through createApp: limits over the environment's, and the clock (the worker's, for deferrals). */
export interface QuotaOptions {
  limits?: Partial<QuotaLimits>;
  /** Defaults to the distribute clock when createApp is given one (GWP#74), else to real time. */
  now?: () => Date;
}

/**
 * The limiter the app provides. Enforced outside tests; under NODE_ENV=test only when `options` is
 * given, as the worker's autoRun is (distribute.options.ts): the integration files share one Postgres
 * and reuse subjects, and QuotaWindow rows outlive a file. Logs one `quotas` line with the effective
 * values, tagged `startup: true` so stdout (CloudWatch) keeps it whatever LOG_STDOUT_LEVEL is (GWP#134).
 * The clock is `options.now`, else `distributeNow` (the worker's, so a test that fakes only that clock
 * defers to its window ends), else real time; `distributeNow` alone does not turn enforcement on.
 */
export function quotaLimiter(
  db: Database, options: QuotaOptions | undefined, env: NodeJS.ProcessEnv = process.env,
  log: (fields: object, message: string) => void = (fields, message) => apiLogger.info(fields, message), distributeNow?: () => Date,
): QuotaLimiter {
  const limits = { ...quotasFromEnv(env), ...options?.limits };
  const enforced = options !== undefined || env.NODE_ENV !== 'test';
  log({ enforced, ...limits, startup: true }, 'quotas');
  const now = options?.now ?? distributeNow;
  return new QuotaLimiter({ store: new PostgresQuotaStore(db), limits: enforced ? limits : undefined, ...(now ? { now } : {}) });
}

/** A deferred delivery's lastError: not an attempt, and never counted toward MAX_ATTEMPTS. */
export const QUOTA_DEFERRED = 'quota_deferred';

/** What a refused delivery take writes: due again when the window ends. */
export function deferral(verdict: Extract<QuotaVerdict, { allowed: false }>): { nextAttemptAt: Date; lastError: typeof QUOTA_DEFERRED } {
  return { nextAttemptAt: verdict.windowEnd, lastError: QUOTA_DEFERRED };
}

const QUOTA = Symbol('quota');

/** Takes `quota` before the handler: by the signed-in subject, or by the route's :teamId. */
export const TakeQuota = (quota: Exclude<QuotaName, 'deliveries'>) => applyDecorators(SetMetadata(QUOTA, quota), UseGuards(QuotaGuard));

/** The guard behind @TakeQuota: 429 with Retry-After past the limit, 503 if the store cannot be reached. */
@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(@Inject(QuotaLimiter) private readonly limiter: QuotaLimiter, @Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const quota = this.reflector.get<QuotaName | undefined>(QUOTA, context.getHandler());
    if (!quota) return true;
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const teamId = (req.params as Record<string, unknown> | undefined)?.teamId;
    const id = QUOTA_WINDOWS[quota].by === 'subject' ? identityOf(req)?.subject : typeof teamId === 'string' ? teamId : undefined;
    // The global guards have already refused a request without either; nothing to count it against.
    if (!id) return true;
    let verdict: QuotaVerdict;
    try {
      verdict = await this.limiter.take(quota, id);
    } catch (error) {
      apiLogger.error({ err: error, quota }, 'quota store unavailable');
      throw new ServiceUnavailableException('This is unavailable; try again shortly');
    }
    if (verdict.allowed) return true;
    http.getResponse<Response>().setHeader('Retry-After', String(verdict.retryAfterSeconds));
    throw new HttpException(QUOTA_WINDOWS[quota].message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

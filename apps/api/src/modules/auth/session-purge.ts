// The periodic purge of expired sign-ins and sessions (GWP#16, docs/auth.md). Rows past expiresAt are
// never read again, but anyone can add a LoginAttempt with GET /auth/login and a session that is never
// presented again is never deleted on read, so without this both tables grow without bound. It also
// deletes the sign-in rate limit's ended windows (LoginRateWindow, GWP#32) and the quotas' (QuotaWindow,
// GWP#50, at windowStart + windowMs, so an hourly or daily window lives out its length), and applies the
// Identity retention rule (GWP#143): a profile 90 days past its last sign-in whose subject is in no team and
// has no unexpired session. It runs in the API
// process: once at startup, then every SESSION_PURGE_MS (default 15 minutes). Several tasks may
// purge at once; the deletes are idempotent. Each run is a `auth.session_purge` span, a RED record
// (session_purge_* in @getworkdone/telemetry) and a log line with the rows deleted. On a fresh instance it
// first waits for its tables (GWP#101, ../database/schema-ready.ts): Identity, the newest of the five,
// checked at once and then every minute, with one `warn` while absent and one `info` when it starts.
import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { recordSessionPurge, withSpan } from '@getworkdone/telemetry';
import { apiLogger } from '../../common/logger.js';
import { waitForSchema, type SchemaWait } from '../database/schema-ready.js';
import { SessionsService } from './sessions.service.js';

export const DEFAULT_SESSION_PURGE_MS = 15 * 60_000;
/** The table the purge waits for: the newest of the five it deletes from. */
export const SESSION_PURGE_TABLE = 'Identity';

export interface SessionPurgeOptions {
  /** Purge at startup and on the interval; off under NODE_ENV=test, where tests call runOnce. */
  autoRun: boolean;
  intervalMs: number;
  now?: () => Date;
  /** Whether SESSION_PURGE_TABLE exists yet; the first run waits for it (AuthModule passes schemaReady). Absent, it starts at once. */
  tableReady?: () => Promise<boolean>;
}

/** The purge's schedule from SESSION_PURGE_MS and NODE_ENV. */
export function sessionPurgeOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): SessionPurgeOptions {
  const ms = Number(env.SESSION_PURGE_MS);
  return { autoRun: env.NODE_ENV !== 'test', intervalMs: Number.isInteger(ms) && ms > 0 ? ms : DEFAULT_SESSION_PURGE_MS };
}

@Injectable()
export class SessionPurge implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private schema: SchemaWait | undefined;

  constructor(private readonly sessions: SessionsService, private readonly options: SessionPurgeOptions) {}

  onApplicationBootstrap(): void {
    if (!this.options.autoRun) return;
    const start = () => {
      this.timer = setInterval(() => this.tick(), this.options.intervalMs);
      this.timer.unref();
      this.tick();
    };
    const { tableReady } = this.options;
    if (!tableReady) return start();
    this.schema = waitForSchema({ job: 'session purge', table: SESSION_PURGE_TABLE, check: tableReady, firstDelayMs: this.options.intervalMs, onReady: start });
  }

  async onModuleDestroy(): Promise<void> {
    // The run in hand finishes before the database client disconnects.
    await this.schema?.stop();
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Starts a run in the background unless one is in flight; a failed run is logged, never thrown. */
  private tick(): void {
    if (this.running) return;
    this.running = this.runOnce()
      .then(() => undefined, (error: unknown) => apiLogger.error({ err: error }, 'session purge failed'))
      .finally(() => {
        this.running = undefined;
      });
  }

  /** One purge: deletes the expired rows and records the run; resolves with the rows deleted. */
  async runOnce(): Promise<{ loginAttempts: number; sessions: number; loginRateWindows: number; quotaWindows: number; identities: number }> {
    const start = performance.now();
    const seconds = () => (performance.now() - start) / 1000;
    try {
      const deleted = await withSpan('auth.session_purge', async (span) => {
        const counts = await this.sessions.purgeExpired(this.options.now?.() ?? new Date());
        span.setAttributes({ 'purge.login_attempts': counts.loginAttempts, 'purge.sessions': counts.sessions, 'purge.login_rate_windows': counts.loginRateWindows, 'purge.quota_windows': counts.quotaWindows, 'purge.identities': counts.identities });
        return counts;
      });
      const durationSeconds = seconds();
      recordSessionPurge({ status: 'ok', durationSeconds, deleted });
      apiLogger.info({ login_attempts_deleted: deleted.loginAttempts, sessions_deleted: deleted.sessions, login_rate_windows_deleted: deleted.loginRateWindows, quota_windows_deleted: deleted.quotaWindows, identities_deleted: deleted.identities, duration_ms: Math.round(durationSeconds * 1000) }, 'session purge');
      return deleted;
    } catch (error) {
      recordSessionPurge({ status: 'error', durationSeconds: seconds() });
      throw error;
    }
  }
}

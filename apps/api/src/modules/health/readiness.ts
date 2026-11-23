// The readiness check (GWP#53, docs/observability.md "Signals"): SELECT 1 through the shared Prisma
// client, cut off after 2 s. GET /readyz serves its last result while it is under 30 s old and checks
// again otherwise. A rule needs a continuous signal and nothing polls /readyz between deploys, so the API
// also runs the check in process: once at startup, then every READINESS_INTERVAL_MS (default 30 s), in
// the shape of the session purge (auth/session-purge.ts). Each check records the gauge database_ready
// (1 or 0), which the `<env> database unreachable` rule reads.
//
// The ALB health check stays /healthz, which checks nothing: a database blip must not make the ALB kill
// every task (docs/deploy/sandbox.md).
import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { recordDatabaseReady } from '@getworkdone/telemetry';
import { apiLogger } from '../../common/logger.js';
import { Database } from '../database/database.js';

export const DEFAULT_READINESS_INTERVAL_MS = 30_000;
export const READINESS_TIMEOUT_MS = 2_000;

export interface ReadinessOptions {
  /** Check at startup and on the interval; off under NODE_ENV=test, where /readyz and tests call check. */
  autoRun: boolean;
  intervalMs: number;
  /** How long a check waits for SELECT 1 before it counts as down. */
  timeoutMs: number;
  /** How old a result /readyz still serves; older, it checks again. */
  maxAgeMs: number;
  /** The clock results are aged on, in ms; defaults to performance.now. */
  now?: () => number;
}

/** The check's schedule from READINESS_INTERVAL_MS and NODE_ENV. */
export function readinessOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ReadinessOptions {
  const ms = Number(env.READINESS_INTERVAL_MS);
  return {
    autoRun: env.NODE_ENV !== 'test',
    intervalMs: Number.isInteger(ms) && ms > 0 ? ms : DEFAULT_READINESS_INTERVAL_MS,
    timeoutMs: READINESS_TIMEOUT_MS,
    maxAgeMs: DEFAULT_READINESS_INTERVAL_MS,
  };
}

@Injectable()
export class Readiness implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<boolean> | undefined;
  private last: { ready: boolean; at: number } | undefined;
  /** A SELECT 1 that has not settled: the timeout stops waiting for it, not the query itself. */
  private query: Promise<boolean> | undefined;

  constructor(private readonly db: Database, private readonly options: ReadinessOptions) {}

  onApplicationBootstrap(): void {
    if (!this.options.autoRun) return;
    this.timer = setInterval(() => void this.check(), this.options.intervalMs);
    this.timer.unref();
    void this.check();
  }

  async onModuleDestroy(): Promise<void> {
    // The check in hand finishes before the database client disconnects.
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** The last result if it is under maxAgeMs old, else a fresh check. */
  async current(): Promise<boolean> {
    if (this.last && this.now() - this.last.at < this.options.maxAgeMs) return this.last.ready;
    return this.check();
  }

  /** Runs SELECT 1 (or joins the check in flight), records database_ready and resolves whether it answered. */
  check(): Promise<boolean> {
    this.running ??= this.probe().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async probe(): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((done) => {
      timer = setTimeout(() => done(false), this.options.timeoutMs);
    });
    let ready: boolean;
    try {
      // While a blackholed query is still outstanding, wait on it again rather than queue another
      // connection attempt in the pool every interval.
      this.query ??= this.db.client.$queryRaw`SELECT 1`.then(() => true).finally(() => {
        this.query = undefined;
      });
      ready = await Promise.race([this.query, timeout]);
    } catch (error) {
      apiLogger.warn({ err: error }, 'readiness check: the database did not answer');
      ready = false;
    } finally {
      clearTimeout(timer);
    }
    this.last = { ready, at: this.now() };
    recordDatabaseReady(ready);
    return ready;
  }

  private now(): number {
    return this.options.now?.() ?? performance.now();
  }
}

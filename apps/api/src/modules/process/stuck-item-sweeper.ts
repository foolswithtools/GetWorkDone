// The stuck-item sweeper (GWP#55, docs/process.md "Resume"). An item whose processing stopped between two
// transitions (the request ended, the task stopped, the database dropped the connection) stays `open` or
// `in_progress` without waiting at a human step until something advances it. This does, without an admin:
// every STUCK_ITEM_SWEEP_MS (default 5 minutes), and once at startup, it lists up to 50 such items not
// updated for STUCK_ITEM_AFTER_MS (default 10 minutes, longer than any transaction or delivery deadline,
// so no live request is still moving them), oldest first, and advances each with no actor, as Resume does
// for an admin. It runs in the API process, modelled on the session purge (session-purge.ts). Several
// tasks may sweep at once: each advance matches on the rowVersion it listed, so an item moves once and
// the other sweep's 409 is counted `skipped`. Each run is a `process.sweep` span, the metrics
// process_sweeper_runs_total{status} and process_sweeper_items_total{result} (recordProcessSweep in
// @getworkdone/telemetry) and a log line `stuck item sweep` with the counts. On a fresh instance it first
// waits for its schema (GWP#101, ../database/schema-ready.ts): the column Item.sweepRetryAt (GWP#127),
// which the newest migration the sweep needs (20261102000000_sweep_backoff) adds in one statement with
// Item.sweepFailures, after the migration that adds Item.waitingRole (20261031120000); so once it exists
// every column the sweep's filter and backoff use does. (Until GWP#127 it waited for the Item(status,
// updatedAt) index that migration also added, which an API started on a schema migrated up to the index but
// not the backoff passed, and then every sweep failed; 20261103180000_drop_item_status_updated_at_idx,
// GWP#158, has since dropped that index.) Checked at once and then every minute, with one `warn` while
// absent and one `info` when it starts.
//
// An item whose advance fails is backed off (GWP#102), so items that always fail never fill the batch
// ahead of a real stuck item: it is not listed again for STUCK_ITEM_AFTER_MS doubled per failure in a
// row (10, 20, 40 minutes, ...), at most 24 hours, and from the fifth failure its log line is an error,
// for a person to look at the item. Once its wait is over it is listed after every item not yet tried
// (ProcessService.stuckItems). Any transition clears the backoff.
import { ConflictException, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { recordProcessSweep, withSpan } from '@getworkdone/telemetry';
import { apiLogger } from '../../common/logger.js';
import { waitForSchema, type SchemaWait } from '../database/schema-ready.js';
import { ProcessService, type StuckItem } from './process.service.js';

export const DEFAULT_STUCK_ITEM_SWEEP_MS = 5 * 60_000;
export const DEFAULT_STUCK_ITEM_AFTER_MS = 10 * 60_000;
/** The most items one sweep advances. */
export const STUCK_ITEM_BATCH = 50;
/** The longest the sweeper waits before it tries again an item it could not advance (GWP#102). */
export const MAX_SWEEP_BACKOFF_MS = 24 * 60 * 60_000;
/** From this many failures in a row, a failed advance logs an error rather than a warning (GWP#102). */
export const SWEEP_FAILURES_TO_ESCALATE = 5;

/** How long after its `failures`-th failure in a row (1, 2, ...) an item waits: afterMs doubled per failure after the first, capped. */
export function sweepBackoffMs(afterMs: number, failures: number): number {
  return Math.min(afterMs * 2 ** (failures - 1), MAX_SWEEP_BACKOFF_MS);
}

/** What the sweeper waits for: the column added last of those the sweep uses (20261102000000_sweep_backoff; GWP#127). */
export const STUCK_ITEM_COLUMN = { table: 'Item', column: 'sweepRetryAt' } as const;

export interface StuckItemSweeperOptions {
  /** Sweep at startup and on the interval; off under NODE_ENV=test, where tests call runOnce. */
  autoRun: boolean;
  intervalMs: number;
  /** How long an item must have gone without an update before it is advanced. */
  afterMs: number;
  /** The most items one run advances; STUCK_ITEM_BATCH when absent. */
  batch?: number;
  now?: () => Date;
  /** Whether STUCK_ITEM_COLUMN exists yet; the first sweep waits for it (ProcessModule passes columnReady). Absent, it starts at once. */
  tableReady?: () => Promise<boolean>;
}

export interface SweepCounts { resumed: number; skipped: number; failed: number }

const positiveWhole = (value: string | undefined, fallback: number) => {
  const ms = Number(value);
  return Number.isInteger(ms) && ms > 0 ? ms : fallback;
};

/** The sweeper's schedule from STUCK_ITEM_SWEEP_MS, STUCK_ITEM_AFTER_MS and NODE_ENV. */
export function stuckItemSweeperOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): StuckItemSweeperOptions {
  return {
    autoRun: env.NODE_ENV !== 'test',
    intervalMs: positiveWhole(env.STUCK_ITEM_SWEEP_MS, DEFAULT_STUCK_ITEM_SWEEP_MS),
    afterMs: positiveWhole(env.STUCK_ITEM_AFTER_MS, DEFAULT_STUCK_ITEM_AFTER_MS),
  };
}

@Injectable()
export class StuckItemSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private schema: SchemaWait | undefined;

  constructor(private readonly process: ProcessService, private readonly options: StuckItemSweeperOptions) {}

  onApplicationBootstrap(): void {
    if (!this.options.autoRun) return;
    const start = () => {
      this.timer = setInterval(() => this.tick(), this.options.intervalMs);
      this.timer.unref();
      this.tick();
    };
    const { tableReady } = this.options;
    if (!tableReady) return start();
    this.schema = waitForSchema({ job: 'stuck item sweeper', table: `${STUCK_ITEM_COLUMN.table}.${STUCK_ITEM_COLUMN.column}`, check: tableReady, firstDelayMs: this.options.intervalMs, onReady: start });
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
      .then(() => undefined, (error: unknown) => apiLogger.error({ err: error }, 'stuck item sweep failed'))
      .finally(() => {
        this.running = undefined;
      });
  }

  /**
   * One sweep: advances the items listed, oldest first, and records the run; resolves with the counts. An
   * item is `resumed` when the advance moved it, `skipped` when someone moved it first (409) or the
   * advance had nothing to do, and `failed` when it threw anything else, which is logged and the run goes
   * on. A failed listing rejects.
   */
  async runOnce(): Promise<SweepCounts> {
    const start = performance.now();
    try {
      const counts = await withSpan('process.sweep', async (span) => {
        const now = this.options.now?.() ?? new Date();
        const before = new Date(now.getTime() - this.options.afterMs);
        const items = await this.process.stuckItems(before, this.options.batch ?? STUCK_ITEM_BATCH, now);
        const result: SweepCounts = { resumed: 0, skipped: 0, failed: 0 };
        for (const item of items) result[await this.advance(item, now)] += 1;
        span.setAttributes({ 'sweep.listed': items.length, 'sweep.resumed': result.resumed, 'sweep.skipped': result.skipped, 'sweep.failed': result.failed });
        return result;
      });
      recordProcessSweep({ status: 'ok', items: counts });
      apiLogger.info({ items_resumed: counts.resumed, items_skipped: counts.skipped, items_failed: counts.failed, duration_ms: Math.round(performance.now() - start) }, 'stuck item sweep');
      return counts;
    } catch (error) {
      recordProcessSweep({ status: 'error' });
      throw error;
    }
  }

  private async advance(item: StuckItem, now: Date): Promise<keyof SweepCounts> {
    try {
      const advanced = await this.process.advance(item.teamId, item.id, item.rowVersion, null);
      return advanced.rowVersion > item.rowVersion ? 'resumed' : 'skipped';
    } catch (error) {
      if (error instanceof ConflictException) return 'skipped';
      await this.backOff(item, now, error);
      return 'failed';
    }
  }

  /** GWP#102: one log line for the failed advance, a warning until the fifth failure in a row, and the item's next try put off. */
  private async backOff(item: StuckItem, now: Date, error: unknown): Promise<void> {
    const failures = item.sweepFailures + 1;
    const retryAt = new Date(now.getTime() + sweepBackoffMs(this.options.afterMs, failures));
    const fields = { item_id: item.id, team_id: item.teamId, sweep_failures: failures, sweep_retry_at: retryAt.toISOString(), err: error };
    if (failures >= SWEEP_FAILURES_TO_ESCALATE) apiLogger.error(fields, 'stuck item sweep could not advance an item');
    else apiLogger.warn(fields, 'stuck item sweep could not advance an item');
    try {
      await this.process.backOffStuckItem(item, retryAt);
    } catch (backOffError) {
      // The item is listed again on the next run, as before GWP#102; the run goes on.
      apiLogger.warn({ item_id: item.id, team_id: item.teamId, err: backOffError }, 'stuck item sweep could not back off an item');
    }
  }
}

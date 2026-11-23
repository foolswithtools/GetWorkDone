import { ConflictException } from '@nestjs/common';
import type { ItemDetailResponse } from '@getworkdone/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiLogger } from '../src/common/logger.js';
import type { ProcessService, StuckItem } from '../src/modules/process/process.service.js';
import { StuckItemSweeper, stuckItemSweeperOptionsFromEnv, sweepBackoffMs } from '../src/modules/process/stuck-item-sweeper.js';

// Partition `unit`: the stuck-item sweeper's schedule, overlap guard, shutdown and counting with
// ProcessService faked and the clock fixed; stuck-item-sweeper.integration.test.ts runs it against
// Postgres (GWP#55). The backoff of an item whose advance keeps failing is GWP#102.

const item = (id: string, rowVersion = 0, sweepFailures = 0): StuckItem => ({ teamId: 'team', id, rowVersion, sweepFailures });

/** A fake ProcessService: `stuck` lists the items, `advance` answers each by id (default: moved on one). */
function processStub(stuck: () => Promise<StuckItem[]>, advance: (itemId: string, rowVersion: number) => Promise<Pick<ItemDetailResponse, 'rowVersion'>> = async (_id, v) => ({ rowVersion: v + 1 })) {
  return {
    stuckItems: vi.fn(stuck),
    advance: vi.fn((_teamId: string, itemId: string, rowVersion: number, _actor: string | null) => advance(itemId, rowVersion)),
    backOffStuckItem: vi.fn(async (_item: StuckItem, _retryAt: Date) => undefined),
  } as unknown as ProcessService & { stuckItems: ReturnType<typeof vi.fn>; advance: ReturnType<typeof vi.fn>; backOffStuckItem: ReturnType<typeof vi.fn> };
}

const none = async () => [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('StuckItemSweeper', () => {
  it('runs once at bootstrap and then every intervalMs, asking for items not updated for afterMs by its clock', async () => {
    vi.useFakeTimers();
    const process = processStub(none);
    const now = new Date('2026-10-31T12:00:00Z');
    const sweeper = new StuckItemSweeper(process, { autoRun: true, intervalMs: 1_000, afterMs: 600_000, now: () => now });
    sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(process.stuckItems).toHaveBeenCalledTimes(1);
    expect(process.stuckItems).toHaveBeenCalledWith(new Date('2026-10-31T11:50:00Z'), 50, now);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(process.stuckItems).toHaveBeenCalledTimes(3);
    await sweeper.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(process.stuckItems).toHaveBeenCalledTimes(3);
  });

  it('does nothing on its own when autoRun is off; runOnce still sweeps and returns the counts', async () => {
    vi.useFakeTimers();
    const process = processStub(async () => [item('a')]);
    const sweeper = new StuckItemSweeper(process, { autoRun: false, intervalMs: 1_000, afterMs: 600_000 });
    sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(process.stuckItems).not.toHaveBeenCalled();
    expect(await sweeper.runOnce()).toEqual({ resumed: 1, skipped: 0, failed: 0 });
    await sweeper.onModuleDestroy();
  });

  it('a tick while a run is in flight starts no second run, and shutdown waits for the run in hand', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const process = processStub(() => new Promise((resolve) => { release = () => resolve([]); }));
    const sweeper = new StuckItemSweeper(process, { autoRun: true, intervalMs: 1_000, afterMs: 600_000 });
    sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(process.stuckItems).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = sweeper.onModuleDestroy().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('advances each listed item in the order given (oldest first), with no actor, at most `batch` of them', async () => {
    const listed = [item('old', 3), item('older', 1), item('newest', 0)];
    const process = processStub(async () => listed);
    const sweeper = new StuckItemSweeper(process, { autoRun: false, intervalMs: 1_000, afterMs: 600_000, batch: 7 });
    await sweeper.runOnce();
    expect(process.stuckItems).toHaveBeenCalledWith(expect.any(Date), 7, expect.any(Date));
    expect(process.advance.mock.calls).toEqual([['team', 'old', 3, null], ['team', 'older', 1, null], ['team', 'newest', 0, null]]);
  });

  it('a 409 is skipped and counted, an advance that writes nothing is skipped, and a thrown error is counted failed while the run goes on', async () => {
    const logged = vi.spyOn(apiLogger, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(apiLogger, 'info').mockImplementation(() => undefined);
    const process = processStub(async () => [item('raced'), item('broken'), item('unmoved', 2), item('fine')], async (id, v) => {
      if (id === 'raced') throw new ConflictException('The item changed since it was read; read it again');
      if (id === 'broken') throw new Error('connection terminated');
      if (id === 'unmoved') return { rowVersion: v };
      return { rowVersion: v + 3 };
    });
    const sweeper = new StuckItemSweeper(process, { autoRun: false, intervalMs: 1_000, afterMs: 600_000 });
    expect(await sweeper.runOnce()).toEqual({ resumed: 1, skipped: 2, failed: 1 });
    expect(process.advance).toHaveBeenCalledTimes(4);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ item_id: 'broken', sweep_failures: 1, err: expect.any(Error) }), 'stuck item sweep could not advance an item');
    // Only the failed item is backed off; a 409, an unmoved item and a resumed one are not.
    expect(process.backOffStuckItem.mock.calls.map(([backedOff]) => backedOff.id)).toEqual(['broken']);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ items_resumed: 1, items_skipped: 2, items_failed: 1 }), 'stuck item sweep');
  });

  it('a failed advance backs the item off by afterMs doubled per earlier failure (afterMs, 2x, 4x, ...), capped at 24 hours, from its clock', async () => {
    vi.spyOn(apiLogger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(apiLogger, 'error').mockImplementation(() => undefined);
    const now = new Date('2026-11-01T00:00:00Z');
    const listed = [0, 1, 2, 3, 7, 8, 40].map((failures) => item(`f${failures}`, 2, failures));
    const process = processStub(async () => listed, async () => { throw new Error('the engine cannot run this definition'); });
    const sweeper = new StuckItemSweeper(process, { autoRun: false, intervalMs: 1_000, afterMs: 600_000, now: () => now });
    expect(await sweeper.runOnce()).toEqual({ resumed: 0, skipped: 0, failed: 7 });
    const minutes = (call: unknown[]) => ((call[1] as Date).getTime() - now.getTime()) / 60_000;
    // 10, 20, 40, 80 minutes, ..., 1280 minutes after the eighth failure; the ninth and later wait 24 hours.
    expect(process.backOffStuckItem.mock.calls.map(minutes)).toEqual([10, 20, 40, 80, 1280, 1440, 1440]);
    expect(process.backOffStuckItem.mock.calls[0]?.[0]).toEqual(listed[0]);
    expect(sweepBackoffMs(600_000, 1)).toBe(600_000);
    expect(sweepBackoffMs(600_000, 2)).toBe(1_200_000);
    expect(sweepBackoffMs(600_000, 2_000)).toBe(24 * 60 * 60_000);
  });

  it('the fifth failure in a row, and each one after, logs one `error` line naming the item instead of a warning', async () => {
    const warn = vi.spyOn(apiLogger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(apiLogger, 'error').mockImplementation(() => undefined);
    const fail = async () => { throw new Error('the database refused the row'); };
    const sweep = (failures: number) => new StuckItemSweeper(processStub(async () => [item('stubborn', 4, failures)], fail), { autoRun: false, intervalMs: 1_000, afterMs: 600_000 }).runOnce();

    await sweep(3);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ item_id: 'stubborn', team_id: 'team', sweep_failures: 4 }), 'stuck item sweep could not advance an item');
    expect(error).not.toHaveBeenCalled();
    warn.mockClear();

    await sweep(4);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ item_id: 'stubborn', team_id: 'team', sweep_failures: 5, sweep_retry_at: expect.any(String), err: expect.any(Error) }), 'stuck item sweep could not advance an item');
    expect(warn).not.toHaveBeenCalled();

    await sweep(11);
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenLastCalledWith(expect.objectContaining({ item_id: 'stubborn', sweep_failures: 12 }), 'stuck item sweep could not advance an item');
  });

  it('a backoff the database refuses is logged and the item still counted failed; the run goes on', async () => {
    const warn = vi.spyOn(apiLogger, 'warn').mockImplementation(() => undefined);
    const process = processStub(async () => [item('broken'), item('fine')], async (id, v) => {
      if (id === 'broken') throw new Error('connection terminated');
      return { rowVersion: v + 1 };
    });
    process.backOffStuckItem.mockRejectedValueOnce(new Error('connection terminated'));
    const sweeper = new StuckItemSweeper(process, { autoRun: false, intervalMs: 1_000, afterMs: 600_000 });
    expect(await sweeper.runOnce()).toEqual({ resumed: 1, skipped: 0, failed: 1 });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ item_id: 'broken', err: expect.any(Error) }), 'stuck item sweep could not back off an item');
  });

  it('a failed listing is logged and never thrown by the timer, and the next tick runs again; runOnce rethrows it', async () => {
    vi.useFakeTimers();
    let fail = true;
    const process = processStub(async () => {
      if (fail) throw new Error('db down');
      return [];
    });
    const logged = vi.spyOn(apiLogger, 'error').mockImplementation(() => undefined);
    const sweeper = new StuckItemSweeper(process, { autoRun: true, intervalMs: 1_000, afterMs: 600_000 });
    sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'stuck item sweep failed');
    fail = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(process.stuckItems).toHaveBeenCalledTimes(2);
    await expect(new StuckItemSweeper(processStub(async () => { throw new Error('db down'); }), { autoRun: false, intervalMs: 1_000, afterMs: 600_000 }).runOnce()).rejects.toThrow('db down');
    await sweeper.onModuleDestroy();
  });
});

describe('StuckItemSweeper before the schema exists (GWP#101)', () => {
  it('sweeps nothing while its schema is absent, warns once, then logs started and runs on its interval', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(apiLogger, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(apiLogger, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(apiLogger, 'error').mockImplementation(() => undefined);
    let exists = false;
    const tableReady = vi.fn(async () => exists);
    const process = processStub(none);
    const sweeper = new StuckItemSweeper(process, { autoRun: true, intervalMs: 5 * 60_000, afterMs: 600_000, tableReady });
    sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(tableReady).toHaveBeenCalledTimes(4);
    expect(process.stuckItems).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith({ table: 'Item.sweepRetryAt' }, 'stuck item sweeper waiting for the database schema');
    expect(error).not.toHaveBeenCalled();
    exists = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(info).toHaveBeenCalledWith('stuck item sweeper started');
    expect(process.stuckItems).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(process.stuckItems).toHaveBeenCalledTimes(2);
    expect(tableReady).toHaveBeenCalledTimes(5);
    await sweeper.onModuleDestroy();
  });

  it('shutdown while it waits cancels the wait', async () => {
    vi.useFakeTimers();
    vi.spyOn(apiLogger, 'warn').mockImplementation(() => undefined);
    const tableReady = vi.fn(async () => false);
    const process = processStub(none);
    const sweeper = new StuckItemSweeper(process, { autoRun: true, intervalMs: 1_000, afterMs: 600_000, tableReady });
    sweeper.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    await sweeper.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tableReady).toHaveBeenCalledTimes(1);
    expect(process.stuckItems).not.toHaveBeenCalled();
  });
});

describe('stuckItemSweeperOptionsFromEnv', () => {
  it('sweeps every 5 minutes for items 10 minutes still unless the variables are positive whole numbers; off under NODE_ENV=test', () => {
    expect(stuckItemSweeperOptionsFromEnv({})).toMatchObject({ autoRun: true, intervalMs: 300_000, afterMs: 600_000 });
    expect(stuckItemSweeperOptionsFromEnv({ STUCK_ITEM_SWEEP_MS: '60000', STUCK_ITEM_AFTER_MS: '120000', NODE_ENV: 'production' })).toMatchObject({ autoRun: true, intervalMs: 60_000, afterMs: 120_000 });
    for (const bad of ['0', '-5', '1.5', 'often']) {
      expect(stuckItemSweeperOptionsFromEnv({ STUCK_ITEM_SWEEP_MS: bad }).intervalMs, bad).toBe(300_000);
      expect(stuckItemSweeperOptionsFromEnv({ STUCK_ITEM_AFTER_MS: bad }).afterMs, bad).toBe(600_000);
    }
    expect(stuckItemSweeperOptionsFromEnv({ NODE_ENV: 'test' }).autoRun).toBe(false);
  });
});

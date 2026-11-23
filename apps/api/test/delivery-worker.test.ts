import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiLogger } from '../src/common/logger.js';
import type { QuotaLimiter } from '../src/common/quota.js';
import type { Database } from '../src/modules/database/database.js';
import type { DistributeRuntime } from '../src/modules/distribute/distribute.options.js';
import { DeliveryWorker } from '../src/modules/distribute/delivery.worker.js';

// Partition `unit`: the delivery worker waits for the Delivery table before its first claim (GWP#101),
// with a fake Database whose schema check answers `exists` and whose claim transaction finds no row;
// delivery.integration.test.ts and schema-ready.integration.test.ts run it against Postgres.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeDatabase() {
  const state = { exists: false, claimError: undefined as Error | undefined };
  const client = {
    $queryRaw: vi.fn(async () => [{ ready: state.exists }]),
    // A claim: the worker's transaction; no due row, unless told to fail.
    $transaction: vi.fn(async () => {
      if (state.claimError) throw state.claimError;
      return undefined;
    }),
  };
  return { state, client, db: { client } as unknown as Database };
}

const runtime = (pollMs: number): DistributeRuntime => ({
  adapters: {} as DistributeRuntime['adapters'],
  now: () => new Date(),
  autoRun: true,
  pollMs,
});

function logs() {
  return {
    warn: vi.spyOn(apiLogger, 'warn').mockImplementation(() => undefined),
    info: vi.spyOn(apiLogger, 'info').mockImplementation(() => undefined),
    error: vi.spyOn(apiLogger, 'error').mockImplementation(() => undefined),
  };
}

describe('DeliveryWorker before the schema exists', () => {
  it('never claims while the Delivery table is absent, warns once, then logs started and claims', async () => {
    vi.useFakeTimers();
    const log = logs();
    const { state, client, db } = fakeDatabase();
    const worker = new DeliveryWorker(db, runtime(5_000), {} as QuotaLimiter);
    worker.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    // Five checks (0, 5, 15, 35, 75 s), and kicks from completed items in between.
    for (const step of [5_000, 10_000, 20_000, 40_000]) {
      worker.kick();
      await vi.advanceTimersByTimeAsync(step);
    }
    expect(client.$queryRaw).toHaveBeenCalledTimes(5);
    expect(client.$transaction).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledExactlyOnceWith({ table: 'Delivery' }, 'delivery worker waiting for the database schema');
    expect(log.error).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();

    state.exists = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log.info).toHaveBeenCalledExactlyOnceWith('delivery worker started');
    const claimsAtStart = client.$transaction.mock.calls.length;
    expect(claimsAtStart).toBeGreaterThan(0);
    // It polls every pollMs from now on and never checks the schema again.
    await vi.advanceTimersByTimeAsync(5_000 * 3);
    expect(client.$transaction.mock.calls.length).toBeGreaterThan(claimsAtStart);
    expect(client.$queryRaw).toHaveBeenCalledTimes(6);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
    await worker.onModuleDestroy();
  });

  it('a claim that fails after the start is still logged as delivery run failed, at error', async () => {
    vi.useFakeTimers();
    const log = logs();
    const { state, client, db } = fakeDatabase();
    state.exists = true;
    const worker = new DeliveryWorker(db, runtime(1_000), {} as QuotaLimiter);
    worker.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.info).toHaveBeenCalledExactlyOnceWith('delivery worker started');
    state.claimError = new Error('relation "Delivery" does not exist');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(log.error).toHaveBeenCalledWith({ err: state.claimError }, 'delivery run failed');
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
    await worker.onModuleDestroy();
  });

  it('shutdown before the schema exists cancels the wait: no check, no claim, no start afterwards', async () => {
    vi.useFakeTimers();
    const log = logs();
    const { state, client, db } = fakeDatabase();
    const worker = new DeliveryWorker(db, runtime(1_000), {} as QuotaLimiter);
    worker.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    await worker.onModuleDestroy();
    state.exists = true;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
    expect(client.$transaction).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('with autoRun off it neither checks nor claims on its own', async () => {
    vi.useFakeTimers();
    const { client, db } = fakeDatabase();
    const worker = new DeliveryWorker(db, { ...runtime(1_000), autoRun: false }, {} as QuotaLimiter);
    worker.onApplicationBootstrap();
    worker.kick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.$queryRaw).not.toHaveBeenCalled();
    expect(client.$transaction).not.toHaveBeenCalled();
    await worker.onModuleDestroy();
  });
});

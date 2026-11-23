import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiLogger } from '../src/common/logger.js';
import type { Database } from '../src/modules/database/database.js';
import { DeliveryBacklog } from '../src/modules/distribute/delivery.backlog.js';

const runtime = { pollMs: 15_000 };

// Partition `unit`: the delivery backlog gauge counts nothing until the Delivery table exists (GWP#101),
// with a fake Database; delivery-backlog.integration.test.ts reads the gauge against Postgres (GWP#53).

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fakeDatabase() {
  const state = { exists: false };
  const client = {
    $queryRaw: vi.fn(async () => [{ ready: state.exists }]),
    delivery: { count: vi.fn(async () => 7) },
  };
  return { state, client, db: { client } as unknown as Database };
}

describe('DeliveryBacklog before the schema exists', () => {
  it('skips each export without counting while the table is absent, warns once, then counts', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(apiLogger, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(apiLogger, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(apiLogger, 'error').mockImplementation(() => undefined);
    const { state, client, db } = fakeDatabase();
    const backlog = new DeliveryBacklog(db, runtime);
    backlog.onApplicationBootstrap();
    await expect(backlog.pending()).rejects.toThrow(/waiting for the database schema/);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(backlog.pending()).rejects.toThrow(/waiting for the database schema/);
    expect(client.delivery.count).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith({ table: 'Delivery' }, 'delivery backlog gauge waiting for the database schema');
    expect(error).not.toHaveBeenCalled();
    state.exists = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(info).toHaveBeenCalledWith('delivery backlog gauge started');
    expect(await backlog.pending()).toBe(7);
    const checks = client.$queryRaw.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(client.$queryRaw).toHaveBeenCalledTimes(checks);
    await backlog.onModuleDestroy();
  });

  it('an export during the first check waits for its answer, so a migrated database is counted at once', async () => {
    const { state, client, db } = fakeDatabase();
    state.exists = true;
    vi.spyOn(apiLogger, 'info').mockImplementation(() => undefined);
    const backlog = new DeliveryBacklog(db, runtime);
    backlog.onApplicationBootstrap();
    expect(await backlog.pending()).toBe(7);
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
    await backlog.onModuleDestroy();
  });
});

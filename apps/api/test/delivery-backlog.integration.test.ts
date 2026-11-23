import type { INestApplication } from '@nestjs/common';
import { createPrismaClient } from '@getworkdone/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { DeliveryBacklog } from '../src/modules/distribute/delivery.backlog.js';
import { DeliveryWorker } from '../src/modules/distribute/delivery.worker.js';
import { pullMetrics } from './support/metrics.js';
import { publicLookup, startReceiver, type Receiver } from './support/receiver.js';
import { createScratchDatabase, readDelivery, seedPendingDelivery, sharedDatabaseUrl, type ScratchDatabase } from './support/scratch-database.js';
import { fakeWebDist } from './support/web-dist.js';

// Partition `integration`: the distribution_deliveries_pending gauge (GWP#53) counts the pending
// Delivery rows. The gauge counts the whole table, so the test runs on a scratch database of its own
// (another suite's pending rows would count too).
describe('delivery backlog gauge', () => {
  const metrics = pullMetrics();
  let scratch: ScratchDatabase;
  let receiver: Receiver;
  let app: INestApplication;
  const pending: string[] = [];

  beforeAll(async () => {
    scratch = await createScratchDatabase('backlog', sharedDatabaseUrl());
    receiver = await startReceiver();
    for (let i = 0; i < 3; i++) pending.push(await seedPendingDelivery(scratch.url, `${receiver.origin}/ok`));
    const db = createPrismaClient(scratch.url);
    try {
      // One of the three is already delivered.
      await db.delivery.update({ where: { id: pending.pop()! }, data: { status: 'delivered', attempts: 1 } });
      // The seed stores no webhook secret; the worker signs with one, so give the first row's output its secret.
      const row = await db.delivery.findUniqueOrThrow({ where: { id: pending[0]! }, select: { teamId: true, outputId: true, item: { select: { workTypeVersion: { select: { workTypeId: true } } } } } });
      await db.outputSecret.create({ data: { teamId: row.teamId, workTypeId: row.item.workTypeVersion.workTypeId, outputId: row.outputId, secret: 'backlog-test-secret' } });
    } finally {
      await db.$disconnect();
    }
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = scratch.url;
    try {
      app = await createApp({ webDistDir: fakeWebDist(), logger: false, distribute: { webhook: { fetch: receiver.fetch, lookup: publicLookup } } });
      await app.init();
    } finally {
      process.env.DATABASE_URL = saved;
    }
  });
  afterAll(async () => {
    await app?.close();
    await receiver?.close();
    await metrics.close();
    await scratch?.drop();
  });

  const gauge = async () => (await metrics.counter('distribution_deliveries_pending')).map((p) => p.value);

  // An OTel counter series is born at its first value: without this, a task's first failed delivery
  // would read 1, 1, 1 and `increase()` would see no change, so `<env> delivery failed` would stay quiet.
  it('the failed-delivery series of each delivered kind exists at 0 from bootstrap', async () => {
    const failed = (await metrics.counter('distribution_deliveries_total')).filter((p) => p.attributes.status === 'failed');
    expect(failed).toEqual(expect.arrayContaining([
      { attributes: { kind: 'email', status: 'failed' }, value: 0 },
      { attributes: { kind: 'webhook', status: 'failed' }, value: 0 },
    ]));
  });

  it('with two pending rows and one delivered the gauge reads 2; after the worker delivers one, 1', async () => {
    expect(await gauge()).toEqual([2]);
    const item = (await readDelivery(scratch.url, pending[0]!)).itemId;
    expect(await app.get(DeliveryWorker).runOnce({ itemIds: [item] })).toBe(1);
    expect((await readDelivery(scratch.url, pending[0]!)).status).toBe('delivered');
    expect(await gauge()).toEqual([1]);
  });

  // A blackholed database must not fill the pg pool one COUNT per 15 s export, as Readiness already
  // avoids for its SELECT 1 (GWP#86). An exclusive lock on the table stands in for the blackhole.
  it('while one count is outstanding, a second export starts no second query', async () => {
    const db = createPrismaClient(scratch.url);
    let release!: () => void;
    const released = new Promise<void>((done) => {
      release = done;
    });
    const waitingCounts = async () => {
      const rows = await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%count%' AND query ILIKE '%"Delivery"%'`;
      return Number(rows[0]?.n ?? 0);
    };
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 100 && !(await check()); i++) await new Promise((done) => setTimeout(done, 50));
    };
    let locked!: () => void;
    const lockHeld = new Promise<void>((done) => {
      locked = done;
    });
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRaw`LOCK TABLE "Delivery" IN ACCESS EXCLUSIVE MODE`;
      locked();
      await released;
    }, { timeout: 30_000 });
    try {
      await lockHeld;
      const first = gauge();
      await until(async () => (await waitingCounts()) >= 1);
      expect(await waitingCounts()).toBe(1);
      const second = gauge();
      // Long enough for a second COUNT to reach Postgres and queue behind the lock.
      await new Promise((done) => setTimeout(done, 500));
      expect(await waitingCounts()).toBe(1);
      release();
      await holder;
      await Promise.all([first, second]);
      // Once the outstanding count answers, the next export counts again.
      expect(await gauge()).toEqual([1]);
    } finally {
      release();
      await holder.catch(() => undefined);
      await db.$disconnect();
    }
  });

  it('stops counting once the app closes', async () => {
    const pendingCount = vi.spyOn(app.get(DeliveryBacklog), 'pending');
    await gauge();
    expect(pendingCount).toHaveBeenCalledTimes(1);
    const closing = app;
    app = undefined as unknown as INestApplication;
    await closing.close();
    await gauge();
    expect(pendingCount).toHaveBeenCalledTimes(1);
  });
});

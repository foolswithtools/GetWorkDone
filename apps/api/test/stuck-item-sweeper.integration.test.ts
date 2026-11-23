import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { WorkTypeDefinition } from '@getworkdone/contracts';
import { createPrismaClient, Prisma, type PrismaClient } from '@getworkdone/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { apiLogger } from '../src/common/logger.js';
import { ProcessService } from '../src/modules/process/process.service.js';
import { StuckItemSweeper } from '../src/modules/process/stuck-item-sweeper.js';
import { signIn, type SignedIn } from './support/identity.js';
import { exportedMetrics, RESOURCE_ATTRIBUTES } from './support/metrics.js';
import { publicLookup, startReceiver, type Receiver } from './support/receiver.js';
import { createScratchDatabase, migrate, readDelivery, seedPendingDelivery, sharedDatabaseUrl, type ScratchDatabase } from './support/scratch-database.js';
import { fakeWebDist } from './support/web-dist.js';

// Partition `integration`: the stuck-item sweeper against Postgres (GWP#55, docs/process.md "Resume").
// Items are written as a request that stopped leaves them, with updatedAt set by SQL. The sweeps run on
// a clock fixed in 2001 and the items' updatedAt is set relative to it, so items other files (or earlier
// runs) left behind are never older than the cut-off and these runs see only their own. The backoff
// tests (GWP#102) sweep on a clock fixed in 1990, before everything else, and cancel what they wrote.
const run = randomUUID().slice(0, 8);
const sub = (name: string) => `sweep-${name}-${run}`;
const clock = new Date('2001-01-01T00:00:00Z');
const minutesBefore = (minutes: number) => new Date(clock.getTime() - minutes * 60_000);

const fields: WorkTypeDefinition['fields'] = [{ key: 'title', label: 'Title', type: 'text', required: true }];
const persist: WorkTypeDefinition['outputs'] = [{ id: 'keep', kind: 'persist', config: {} }];
const upper = { id: 'upper', name: 'Upper-case the title', kind: 'automated', transform: 'string_case', params: { field: 'title', op: 'upper' } } as const;
const review = { id: 'review', name: 'Review', kind: 'human', assigneeRole: 'member' } as const;

describe('stuck item sweeper', () => {
  let app: INestApplication;
  let second: INestApplication;
  const db = createPrismaClient();
  const metrics = exportedMetrics();
  let admin: SignedIn;
  let teamId: string;
  let versionId: string;
  /** A version whose definition the engine cannot run (no steps), written past the service's validation. */
  let brokenVersionId: string;

  const sweeper = (on = app) => new StuckItemSweeper(on.get(ProcessService), { autoRun: false, intervalMs: 300_000, afterMs: 600_000, now: () => clock });

  /** An item as capture leaves it when processing stops before its first transition: `open`, one `captured` event. */
  async function stuck(updatedAt: Date, extra: { status?: 'open' | 'failed'; workTypeVersionId?: string } = {}) {
    const item = await db.item.create({ data: { teamId, workTypeVersionId: versionId, data: { title: 'new laptop' }, ...extra } });
    await db.itemEvent.create({ data: { itemId: item.id, seq: 1, type: 'captured', actorSubject: sub('admin'), payload: { workTypeVersionId: versionId } } });
    await db.$executeRaw`UPDATE "Item" SET "updatedAt" = ${updatedAt} WHERE id = ${item.id}`;
    return item;
  }

  const row = (itemId: string) => db.item.findUniqueOrThrow({ where: { id: itemId } });
  const events = async (itemId: string) => (await db.itemEvent.findMany({ where: { itemId }, orderBy: { seq: 'asc' } })).map((e) => ({ type: e.type, actorSubject: e.actorSubject }));

  beforeAll(async () => {
    // The 1990-clock items of an earlier run that stopped before cancelling them (GWP#102): left `open`,
    // they would be older than every cut-off here.
    await db.$executeRaw`UPDATE "Item" SET status = 'cancelled' WHERE status IN ('open', 'in_progress') AND "updatedAt" < ${new Date('1991-01-01T00:00:00Z')}`;
    app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
    second = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await second.init();
    admin = await signIn(app, sub('admin'));
    teamId = (await admin.post('/api/v1/teams', { name: 'Sweeper' }).expect(201)).body.id;
    const created = (await admin.post(`/api/v1/teams/${teamId}/work-types`, { slug: 'stuck', definition: { fields, outputs: persist, steps: [upper, review] } }).expect(201)).body;
    versionId = created.version.id;
    brokenVersionId = (await db.workTypeVersion.create({ data: { teamId, workTypeId: created.id, version: 99, definition: { fields, outputs: persist } as Prisma.InputJsonObject } })).id;
  });
  afterAll(async () => {
    await app.close();
    await second.close();
    await db.$disconnect();
    await metrics.close();
  });

  it('is registered in the app, off under NODE_ENV=test', () => {
    const registered = app.get(StuckItemSweeper) as unknown as { options: { autoRun: boolean; intervalMs: number; afterMs: number } };
    expect(registered).toBeInstanceOf(StuckItemSweeper);
    expect(registered.options).toMatchObject({ autoRun: false, intervalMs: 300_000, afterMs: 600_000 });
  });

  it('an `open` item 11 minutes still is advanced to its human step with no actor; one waiting at a human step, one 5 minutes old and a failed one are untouched', async () => {
    const old = await stuck(minutesBefore(11));
    const recent = await stuck(minutesBefore(5));
    const failed = await stuck(minutesBefore(30), { status: 'failed' });

    const counts = await sweeper().runOnce();

    expect(counts).toEqual({ resumed: 1, skipped: 0, failed: 0 });
    expect(await row(old.id)).toMatchObject({ status: 'in_progress', currentStepIndex: 1, rowVersion: 3, waitingRole: 'member', data: { title: 'NEW LAPTOP' } });
    expect(await events(old.id)).toEqual([
      { type: 'captured', actorSubject: sub('admin') },
      { type: 'step_started', actorSubject: null },
      { type: 'step_completed', actorSubject: null },
      { type: 'step_started', actorSubject: null },
    ]);
    expect(await row(recent.id)).toMatchObject({ status: 'open', rowVersion: 0 });
    expect(await row(failed.id)).toMatchObject({ status: 'failed', rowVersion: 0 });

    // Now waiting at Review: however old it gets, the sweeper leaves it for a member.
    await db.$executeRaw`UPDATE "Item" SET "updatedAt" = ${minutesBefore(60)} WHERE id = ${old.id}`;
    expect(await sweeper().runOnce()).toEqual({ resumed: 0, skipped: 0, failed: 0 });
    expect(await row(old.id)).toMatchObject({ status: 'in_progress', rowVersion: 3 });
  });

  it('an item waiting at a started human step with waitingRole null (a step started by code before GWP#55) gets its role and leaves the sweep', async () => {
    const item = await db.item.create({ data: { teamId, workTypeVersionId: versionId, data: { title: 'OLD' }, status: 'in_progress', currentStepIndex: 1, rowVersion: 3 } });
    const event = (seq: number, type: string, payload: object) => ({ itemId: item.id, seq, type, actorSubject: null, payload });
    await db.itemEvent.createMany({
      data: [
        event(1, 'captured', { workTypeVersionId: versionId }), event(2, 'step_started', { stepId: 'upper', stepIndex: 0, kind: 'automated' }),
        event(3, 'step_completed', { stepId: 'upper', stepIndex: 0, kind: 'automated' }), event(4, 'step_started', { stepId: 'review', stepIndex: 1, kind: 'human', assigneeRole: 'member' }),
      ],
    });
    await db.$executeRaw`UPDATE "Item" SET "updatedAt" = ${minutesBefore(40)} WHERE id = ${item.id}`;

    expect(await sweeper().runOnce()).toEqual({ resumed: 0, skipped: 1, failed: 0 });
    // Repaired in place: on the member's queue, no event written, rowVersion unchanged; never listed again.
    expect(await row(item.id)).toMatchObject({ status: 'in_progress', rowVersion: 3, waitingRole: 'member' });
    expect(await events(item.id)).toHaveLength(4);
    expect(await sweeper().runOnce()).toEqual({ resumed: 0, skipped: 0, failed: 0 });
  });

  it('two sweeps at once, from two apps on one database, advance the item once', async () => {
    const item = await stuck(minutesBefore(20));
    const results = await Promise.all([sweeper(app).runOnce(), sweeper(second).runOnce()]);
    const total = results.reduce((sum, r) => ({ resumed: sum.resumed + r.resumed, skipped: sum.skipped + r.skipped, failed: sum.failed + r.failed }));
    expect(total.resumed).toBe(1);
    expect(total.failed).toBe(0);
    expect(await row(item.id)).toMatchObject({ status: 'in_progress', currentStepIndex: 1, rowVersion: 3 });
    expect((await events(item.id)).filter((e) => e.type === 'step_started')).toHaveLength(2);
  });

  it('process_sweeper_runs_total and process_sweeper_items_total are exported with the four resource attributes', async () => {
    await stuck(minutesBefore(15));
    await sweeper().runOnce();
    const runs = await metrics.counter('process_sweeper_runs_total');
    expect(runs.resource).toMatchObject(RESOURCE_ATTRIBUTES);
    expect(runs.points).toEqual(expect.arrayContaining([{ attributes: { status: 'ok' }, value: expect.any(Number) }]));
    const items = await metrics.counter('process_sweeper_items_total');
    expect(items.resource).toMatchObject(RESOURCE_ATTRIBUTES);
    expect(items.points.find((p) => p.attributes.result === 'resumed')?.value).toBeGreaterThanOrEqual(1);
  });

  it('the sweep\'s query (ProcessService.stuckItems) is planned on the partial index Item_status_updatedAt_waiting_null_idx (GWP#157)', async () => {
    // The SQL Prisma 7.10.1 sends for stuckItems, statuses cast from text as it sends them (the cast is why a
    // predicate on status could not be matched, and the index's predicate is waitingRole's alone). With
    // sequential scans off, the table's few rows here do not decide the plan.
    const plan = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<{ 'QUERY PLAN': string }[]>`
        EXPLAIN SELECT "public"."Item"."id", "public"."Item"."teamId", "public"."Item"."rowVersion", "public"."Item"."sweepFailures"
        FROM "public"."Item"
        WHERE ("public"."Item"."status" IN (CAST(${'open'}::text AS "public"."ItemStatus"), CAST(${'in_progress'}::text AS "public"."ItemStatus"))
          AND "public"."Item"."waitingRole" IS NULL AND "public"."Item"."updatedAt" < ${minutesBefore(10)}
          AND ("public"."Item"."sweepRetryAt" IS NULL OR "public"."Item"."sweepRetryAt" <= ${clock}))
        ORDER BY "public"."Item"."sweepFailures" ASC, "public"."Item"."updatedAt" ASC, "public"."Item"."id" ASC LIMIT ${50} OFFSET ${0}`;
    });
    // An index scan on a table without statistics, a bitmap index scan once Item has been analyzed: either
    // reads the partial index.
    expect(plan.map((line) => line['QUERY PLAN']).join('\n')).toMatch(/(Bitmap Index Scan on|Index Scan using) "?Item_status_updatedAt_waiting_null_idx"?/);
  });

  describe('backoff of an item the sweeper cannot advance (GWP#102)', () => {
    const early = new Date('1990-01-01T00:00:00Z');
    const at = (minutes: number) => new Date(early.getTime() + minutes * 60_000);
    const sweepAt = (minutes: number) => new StuckItemSweeper(app.get(ProcessService), { autoRun: false, intervalMs: 300_000, afterMs: 600_000, now: () => at(minutes) }).runOnce();
    const written: string[] = [];
    /** An `open` item last updated `minutes` from `early`; broken (its advance throws) unless `ok`. */
    async function item(minutes: number, ok = false) {
      const created = await stuck(at(minutes), ok ? {} : { workTypeVersionId: brokenVersionId });
      written.push(created.id);
      return created;
    }

    // Nothing this block writes is left for the sweeps on the 2001 clock to list (and the file's
    // beforeAll cancels what a run stopped before this afterAll left).
    afterAll(async () => {
      if (written.length) await db.$executeRaw`UPDATE "Item" SET status = 'cancelled' WHERE id IN (${Prisma.join(written)})`;
    });

    it('51 items whose advance always throws do not hold back a stuck `open` item behind them: the second sweep advances it', async () => {
      const broken = [];
      for (let i = 0; i < 51; i += 1) broken.push(await item(-120 + i));
      const open = await item(-30, true);

      expect(await sweepAt(0)).toEqual({ resumed: 0, skipped: 0, failed: 50 });
      expect(await row(open.id)).toMatchObject({ status: 'open', rowVersion: 0 });
      // Backed off with no event and no rowVersion or updatedAt change.
      const first = await row(broken[0]!.id);
      expect(first).toMatchObject({ status: 'open', rowVersion: 0, sweepFailures: 1, sweepRetryAt: at(10), updatedAt: at(-120) });
      expect(await events(first.id)).toHaveLength(1);

      expect(await sweepAt(5)).toEqual({ resumed: 1, skipped: 0, failed: 1 });
      expect(await row(open.id)).toMatchObject({ status: 'in_progress', currentStepIndex: 1, waitingRole: 'member', rowVersion: 3, sweepFailures: 0, sweepRetryAt: null });
      expect(await row(broken[50]!.id)).toMatchObject({ sweepFailures: 1, sweepRetryAt: at(15) });
    });

    it('with 100 such items, the items never tried go first, so the stuck `open` item moves on the third sweep, not after the retries', async () => {
      const broken = [];
      for (let i = 0; i < 100; i += 1) broken.push(await item(-1000 + i));
      const open = await item(-500, true);
      try {
        expect(await sweepAt(0)).toEqual({ resumed: 0, skipped: 0, failed: 50 });
        expect(await sweepAt(5)).toEqual({ resumed: 0, skipped: 0, failed: 50 });
        // The first 50 may be tried again from minute 10, and are older, but they have failed once.
        expect(await sweepAt(10)).toEqual(expect.objectContaining({ resumed: 1 }));
        expect(await row(open.id)).toMatchObject({ status: 'in_progress', currentStepIndex: 1 });
      } finally {
        // The rest of the block counts its own items: these are done with.
        await db.$executeRaw`UPDATE "Item" SET status = 'cancelled' WHERE id IN (${Prisma.join(broken.map((b) => b.id))})`;
      }
    });

    it('a failing item is listed again only once its sweepRetryAt has passed, and waits twice as long after each failure', async () => {
      // Older than the first test's items, so it is always first in the batch.
      const failing = await item(-300);
      await sweepAt(0);
      expect(await row(failing.id)).toMatchObject({ sweepFailures: 1, sweepRetryAt: at(10) });

      await sweepAt(9);
      expect(await row(failing.id)).toMatchObject({ sweepFailures: 1, sweepRetryAt: at(10) });

      await sweepAt(10);
      expect(await row(failing.id)).toMatchObject({ sweepFailures: 2, sweepRetryAt: at(30) });
      await sweepAt(29);
      expect(await row(failing.id)).toMatchObject({ sweepFailures: 2 });
      await sweepAt(30);
      expect(await row(failing.id)).toMatchObject({ sweepFailures: 3, sweepRetryAt: at(70), rowVersion: 0, updatedAt: at(-300) });
    });

    it('any transition clears sweepRetryAt and sweepFailures', async () => {
      const failing = await item(-200);
      await sweepAt(0);
      await sweepAt(10);
      expect(await row(failing.id)).toMatchObject({ sweepFailures: 2, sweepRetryAt: at(30) });

      // Once the item's version is one the engine can run, an admin's resume moves it on, and its
      // first transition clears the backoff.
      await db.$executeRaw`UPDATE "Item" SET "workTypeVersionId" = ${versionId} WHERE id = ${failing.id}`;
      await admin.post(`/api/v1/teams/${teamId}/items/${failing.id}/advance`, { rowVersion: 0 }).expect(200);
      expect(await row(failing.id)).toMatchObject({ status: 'in_progress', rowVersion: 3, sweepFailures: 0, sweepRetryAt: null });
    });
  });
});

// GWP#127: an API started on a schema that has Item.waitingRole (20261031120000) but not
// sweep_backoff's columns (20261102000000), as a self-hoster who starts the new image before migrating
// has. A scratch database is migrated and then put back to before sweep_backoff: its columns dropped and
// its row in _prisma_migrations deleted, so `prisma migrate deploy` applies it again. The delivery
// worker, which waits only for Delivery, runs there too: it must not read the columns either, or a due
// delivery would use up its attempts and end `failed` before the migration.
describe('the stuck item sweeper on a schema without sweep_backoff (GWP#127)', () => {
  let scratch: ScratchDatabase;
  let client: PrismaClient;
  let receiver: Receiver;
  let app: INestApplication | undefined;
  let deliveryId: string;

  const messages = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => call.filter((arg) => typeof arg === 'string').join(' '));
  const errors = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => JSON.stringify(call, (_k, v: unknown) => (v instanceof Error ? v.message : v)));
  async function until(check: () => boolean, ms = 20_000): Promise<void> {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((done) => setTimeout(done, 50));
    }
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase('sweepwait', sharedDatabaseUrl());
    client = createPrismaClient(scratch.url);
    receiver = await startReceiver();
    // Seeded while the columns exist: Prisma's create reads back every column.
    deliveryId = await seedPendingDelivery(scratch.url, `${receiver.origin}/ok`);
    const row = await client.delivery.findUniqueOrThrow({ where: { id: deliveryId }, select: { teamId: true, outputId: true, item: { select: { workTypeVersion: { select: { workTypeId: true } } } } } });
    await client.outputSecret.create({ data: { teamId: row.teamId, workTypeId: row.item.workTypeVersion.workTypeId, outputId: row.outputId, secret: 'sweepwait-test-secret' } });
    await client.$executeRawUnsafe('ALTER TABLE "Item" DROP COLUMN "sweepRetryAt", DROP COLUMN "sweepFailures"');
    await client.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE migration_name = '20261102000000_sweep_backoff'`);
  });
  afterAll(async () => {
    await app?.close();
    await client?.$disconnect();
    await receiver?.close();
    await scratch?.drop();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('with Item.waitingRole but not Item.sweepRetryAt it waits, logging its waiting line and no failed sweep, and sweeps once `prisma migrate deploy` adds the columns; the delivery worker sends a due delivery meanwhile', async () => {
    expect((await client.$queryRawUnsafe<{ ready: boolean }[]>(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Item' AND column_name = 'waitingRole') AS ready`))[0]?.ready).toBe(true);
    const error = vi.spyOn(apiLogger, 'error');
    const warn = vi.spyOn(apiLogger, 'warn');
    const info = vi.spyOn(apiLogger, 'info');
    // Production mode, so the sweeper runs on its own, every 100 ms once started.
    const env = { NODE_ENV: 'production', IDENTITY_PROVIDER: '', DATABASE_URL: scratch.url, DELIVERY_POLL_MS: '100', SESSION_PURGE_MS: '100', STUCK_ITEM_SWEEP_MS: '100' };
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      app = await createApp({ webDistDir: fakeWebDist(), logger: false, distribute: { webhook: { fetch: receiver.fetch, lookup: publicLookup } } });
      await app.init();
    } finally {
      for (const key of Object.keys(env)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }

    // Long enough for several checks (100, 200, 400, 800 ms apart) and, were it started, many sweeps.
    await new Promise((done) => setTimeout(done, 2_000));
    // The delivery worker needs nothing sweep_backoff adds: the due delivery is sent before the migration.
    expect(await readDelivery(scratch.url, deliveryId)).toMatchObject({ status: 'delivered', attempts: 1 });
    expect(receiver.received.some((r) => r.path === '/ok')).toBe(true);
    const waiting = warn.mock.calls.filter((call) => call[1] === 'stuck item sweeper waiting for the database schema');
    expect(waiting).toEqual([[{ table: 'Item.sweepRetryAt' }, 'stuck item sweeper waiting for the database schema']]);
    expect(messages(info).filter((line) => line.startsWith('stuck item sweep'))).toEqual([]);
    expect(errors(error)).toEqual([]);

    migrate(scratch.url);
    await until(() => messages(info).includes('stuck item sweep'));
    expect(messages(info).filter((line) => line === 'stuck item sweeper started')).toHaveLength(1);
    expect(messages(info).indexOf('stuck item sweeper started')).toBeLessThan(messages(info).indexOf('stuck item sweep'));
    expect(errors(error)).toEqual([]);
  });
});

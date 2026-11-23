import type { INestApplication } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@getworkdone/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { apiLogger } from '../src/common/logger.js';
import type { Database } from '../src/modules/database/database.js';
import { SCHEMA_WAIT_MAX_MS, schemaReady, waitForSchema } from '../src/modules/database/schema-ready.js';
import { publicLookup, startReceiver, type Receiver } from './support/receiver.js';
import { randomUUID } from 'node:crypto';
import { createScratchDatabase, migrate, readDelivery, seedPendingDelivery, sharedDatabaseUrl, type ScratchDatabase } from './support/scratch-database.js';
import { fakeWebDist } from './support/web-dist.js';

// Partition `integration`: an instance's first deploy (GWP#101, docs/deploy/sandbox.md "Migrations").
// The API starts on a scratch database with no migrations, in production mode so the delivery worker,
// the session purge, the stuck-item sweeper and the backlog gauge all run: each logs one `warn` and no
// `error`, and none queries a missing table. After `prisma migrate deploy` each starts by itself and
// the worker sends a due delivery. Run twice: connected as the database owner, and as the sandbox
// connects, with a role of its own that exists only once the migrate task has created it (#57), so the
// API's first queries are refused with 28P01.

const JOBS = ['delivery worker', 'session purge', 'stuck item sweeper', 'delivery backlog gauge'];

/** Every message and error text passed to `spy`, as one string per call. */
const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => call.map((arg) => (arg instanceof Error ? arg.message : typeof arg === 'string' ? arg : JSON.stringify(arg, (_k, v: unknown) => (v instanceof Error ? v.message : v)))).join(' '));

async function until(check: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((done) => setTimeout(done, 50));
  }
}

const TABLES: Record<string, string> = { 'delivery worker': 'Delivery', 'session purge': 'Identity', 'stuck item sweeper': 'Item.sweepRetryAt', 'delivery backlog gauge': 'Delivery' };

describe.each([
  { connectAs: 'the database owner', ownRole: false },
  { connectAs: 'a role the migrate task creates (28P01 until then)', ownRole: true },
])('a fresh instance: the API before its migration, connected as $connectAs', ({ ownRole }) => {
  let scratch: ScratchDatabase;
  let client: PrismaClient;
  let receiver: Receiver;
  let app: INestApplication | undefined;
  const role = `gwd_app_${randomUUID().slice(0, 8)}`;
  const password = randomUUID();

  beforeAll(async () => {
    scratch = await createScratchDatabase('schema', sharedDatabaseUrl(), { migrated: false });
    client = createPrismaClient(scratch.url);
    receiver = await startReceiver();
  });
  afterAll(async () => {
    await app?.close();
    await client?.$disconnect();
    await receiver?.close();
    await scratch?.drop();
    if (ownRole) {
      const server = createPrismaClient(sharedDatabaseUrl());
      await server.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`).finally(() => server.$disconnect());
    }
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The API's URL: the scratch database, as its owner or as `role`. */
  const apiUrl = () => {
    if (!ownRole) return scratch.url;
    const url = new URL(scratch.url);
    url.username = role;
    url.password = password;
    return url.toString();
  };

  /**
   * What the sandbox's migrate task does after `prisma migrate deploy`: create the API's role (app-role.sql, simplified).
   * One transaction, so no connection sees the role before its grants: a job that signed in between them would
   * find the tables, start, and log its first query's 42501 at error (GWP#151).
   */
  async function createRole(): Promise<void> {
    const name = new URL(scratch.url).pathname.slice(1);
    await client.$transaction([
      client.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`),
      client.$executeRawUnsafe(`GRANT CONNECT ON DATABASE "${name}" TO "${role}"`),
      client.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`),
      client.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`),
      client.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`),
    ]);
  }

  it('schemaReady answers false with no migrations', async () => {
    expect(await schemaReady({ client } as unknown as Database, 'Delivery')).toBe(false);
  });

  it('logs one warn per job and no error while the schema is missing, then starts every job once migrated and sends a due delivery', async () => {
    const error = vi.spyOn(apiLogger, 'error');
    const warn = vi.spyOn(apiLogger, 'warn');
    const info = vi.spyOn(apiLogger, 'info');
    // Production mode, as the sandbox runs it; sign-in stays unconfigured (the fake provider is test-only).
    const env = { NODE_ENV: 'production', IDENTITY_PROVIDER: '', DATABASE_URL: apiUrl(), DELIVERY_POLL_MS: '100', SESSION_PURGE_MS: '100', STUCK_ITEM_SWEEP_MS: '100' };
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

    // Long enough for several checks of each job (100, 200, 400, 800 ms apart).
    await new Promise((done) => setTimeout(done, 2_000));
    expect(lines(error)).toEqual([]);
    expect([...lines(warn), ...lines(info)].filter((line) => line.includes('does not exist'))).toEqual([]);
    const waiting = warn.mock.calls.filter((call) => String(call[1]).endsWith('waiting for the database schema'));
    expect(waiting.map((call) => `${(call[0] as { table: string }).table} ${String(call[1])}`).sort()).toEqual(JOBS.map((job) => `${TABLES[job]} ${job} waiting for the database schema`).sort());
    expect(lines(warn).filter((line) => line.includes('starting anyway'))).toEqual([]);
    expect(lines(info).filter((line) => line.endsWith(' started'))).toEqual([]);

    migrate(scratch.url);
    if (ownRole) await createRole();
    expect(await schemaReady({ client } as unknown as Database, 'Delivery')).toBe(true);
    await until(() => JOBS.every((job) => lines(info).includes(`${job} started`)));

    // The worker signs with the output's secret, so the seed writes it with the row (GWP#145).
    const id = await seedPendingDelivery(scratch.url, `${receiver.origin}/ok`, { webhookSecret: 'schema-test-secret' });
    await until(async () => (await readDelivery(scratch.url, id)).status === 'delivered');
    expect(receiver.received.some((r) => r.path === '/ok')).toBe(true);

    expect(lines(error)).toEqual([]);
    expect(lines(warn).filter((line) => line.includes('waiting for the database schema'))).toHaveLength(JOBS.length);
    for (const job of JOBS) expect(lines(info).filter((line) => line === `${job} started`), job).toHaveLength(1);
  });
});

describe('the schema wait\'s backoff', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('doubles from the first delay and is capped at 60 s (fake timers)', async () => {
    vi.useFakeTimers();
    vi.spyOn(apiLogger, 'warn').mockImplementation(() => undefined);
    const at: number[] = [];
    const start = Date.now();
    const wait = waitForSchema({ job: 'test job', table: 'Missing', check: async () => { at.push(Date.now() - start); return false; }, firstDelayMs: 5_000, onReady: () => undefined });
    await vi.advanceTimersByTimeAsync(5 * SCHEMA_WAIT_MAX_MS);
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    expect(gaps).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    await wait.stop();
  });
});

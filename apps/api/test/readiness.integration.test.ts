import { createServer } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { ReadyResponse } from '@getworkdone/contracts';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Readiness } from '../src/modules/health/readiness.js';
import { pullMetrics } from './support/metrics.js';
import { fakeWebDist } from './support/web-dist.js';

/** A loopback port nothing listens on: bound, then released. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

/** The app built with DATABASE_URL set to `url` (the Database provider reads it at construction). */
async function appWithDatabase(url: string | undefined): Promise<INestApplication> {
  const saved = process.env.DATABASE_URL;
  if (url !== undefined) process.env.DATABASE_URL = url;
  try {
    const app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
    return app;
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
}

// Partition `integration`: GET /readyz and the in-process readiness check (GWP#53) against the test
// Postgres, and against a database URL whose port is closed. /healthz checks nothing and stays 200.
describe('readiness', () => {
  const metrics = pullMetrics();
  let healthy: INestApplication;
  let broken: INestApplication;

  beforeAll(async () => {
    healthy = await appWithDatabase(undefined);
    broken = await appWithDatabase(`postgresql://getworkdone:getworkdone@127.0.0.1:${await closedPort()}/getworkdone`);
  });
  afterAll(async () => {
    await healthy.close();
    await broken.close();
    await metrics.close();
  });

  const databaseReady = async () => (await metrics.counter('database_ready')).map((p) => p.value);

  it('/readyz is 200 { status: ok, database: ok } against the test Postgres', async () => {
    const res = await request(healthy.getHttpServer()).get('/readyz');
    expect(res.status).toBe(200);
    expect(ReadyResponse.parse(res.body)).toEqual({ status: 'ok', database: 'ok' });
  });

  it('with the database unreachable /readyz is 503 { status: degraded, database: down } within 2.5 s, and /healthz is still 200', async () => {
    const started = performance.now();
    const res = await request(broken.getHttpServer()).get('/readyz');
    expect(performance.now() - started).toBeLessThan(2500);
    expect(res.status).toBe(503);
    expect(ReadyResponse.parse(res.body)).toEqual({ status: 'degraded', database: 'down' });
    const health = await request(broken.getHttpServer()).get('/healthz');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok' });
  });

  it('the in-process check records database_ready 1, and 0 once the database URL points at a closed port', async () => {
    await healthy.get(Readiness).check();
    expect(await databaseReady()).toEqual([1]);
    await broken.get(Readiness).check();
    expect(await databaseReady()).toEqual([0]);
  });

  it('a check that never answers is cut off at the timeout and counts as down', async () => {
    const readiness = new Readiness({ client: { $queryRaw: () => new Promise(() => undefined) } } as never, { autoRun: false, intervalMs: 30_000, timeoutMs: 50, maxAgeMs: 30_000 });
    await expect(readiness.check()).resolves.toBe(false);
    expect(await databaseReady()).toEqual([0]);
  });

  it('while a timed-out SELECT 1 is still outstanding, the next check waits on it instead of starting another', async () => {
    let queries = 0;
    const readiness = new Readiness({ client: { $queryRaw: () => (queries++, new Promise(() => undefined)) } } as never, { autoRun: false, intervalMs: 30_000, timeoutMs: 20, maxAgeMs: 0 });
    expect(await readiness.check()).toBe(false);
    expect(await readiness.check()).toBe(false);
    expect(queries).toBe(1);
  });

  it('/readyz serves a result under 30 s old instead of checking again', async () => {
    let checks = 0;
    let now = 0;
    const readiness = new Readiness({ client: { $queryRaw: async () => (checks++, [{ '?column?': 1 }]) } } as never, { autoRun: false, intervalMs: 30_000, timeoutMs: 2000, maxAgeMs: 30_000, now: () => now });
    expect(await readiness.current()).toBe(true);
    now = 29_999;
    expect(await readiness.current()).toBe(true);
    expect(checks).toBe(1);
    now = 30_000;
    await readiness.current();
    expect(checks).toBe(2);
  });

  it('RED records /readyz under its route pattern, outside /api/v1', async () => {
    await request(healthy.getHttpServer()).get('/readyz').expect(200);
    const points = (await metrics.requests()).filter((p) => p.attributes.route === '/readyz');
    expect(points.map((p) => p.attributes.status_code).sort()).toEqual([200, 503]);
  });
});

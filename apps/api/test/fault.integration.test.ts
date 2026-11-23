import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { signIn } from './support/identity.js';
import { pullMetrics } from './support/metrics.js';
import { fakeWebDist } from './support/web-dist.js';

// The fault route and the drill route (GWP#9, docs/runbooks/alert-drill.md). The fault module exists only
// when FAULT_INJECTION_ENABLED=true (the dev task definition); only a subject in FAULT_ADMIN_SUBJECTS may
// set a fault, after the global guards, so the CSRF token applies as on every /api/v1 write.

describe('fault injection off (the default, and prod)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false, fault: { enabled: false, adminSubjects: new Set(['drill-admin']) } });
    await app.init();
  });
  afterAll(() => app.close());

  it('neither route exists: an anonymous POST /api/v1/__fault is 404 and a signed-in GET /api/v1/__drill is 404', async () => {
    expect((await request(app.getHttpServer()).post('/api/v1/__fault').send({ mode: 'errors' })).status).toBe(404);
    // The SPA route refuses an anonymous GET under /api/v1 first (deny by default).
    expect((await request(app.getHttpServer()).get('/api/v1/__drill')).status).toBe(401);
    const admin = await signIn(app, 'drill-admin');
    expect((await admin.get('/api/v1/__drill')).status).toBe(404);
    expect((await admin.post('/api/v1/__fault', { mode: 'errors' })).status).toBe(404);
  });

  it('FAULT_INJECTION_ENABLED, FAULT_ADMIN_SUBJECTS and SYNTHETIC_SUBJECTS are read at startup; a malformed value stops it, naming the variable', async () => {
    const saved = { ...process.env };
    try {
      process.env.FAULT_INJECTION_ENABLED = 'yes';
      await expect(createApp({ webDistDir: fakeWebDist(), logger: false })).rejects.toThrow(/^FAULT_INJECTION_ENABLED /);
      process.env.FAULT_INJECTION_ENABLED = 'true';
      process.env.FAULT_ADMIN_SUBJECTS = 'a b';
      await expect(createApp({ webDistDir: fakeWebDist(), logger: false })).rejects.toThrow(/^FAULT_ADMIN_SUBJECTS /);
      process.env.FAULT_ADMIN_SUBJECTS = 'drill-admin';
      process.env.SYNTHETIC_SUBJECTS = 'k6 ci';
      await expect(createApp({ webDistDir: fakeWebDist(), logger: false })).rejects.toThrow(/^SYNTHETIC_SUBJECTS /);
      process.env.SYNTHETIC_SUBJECTS = 'k6-ci';
      const fromEnv = await createApp({ webDistDir: fakeWebDist(), logger: false });
      await fromEnv.init();
      const admin = await signIn(fromEnv, 'drill-admin');
      expect((await admin.get('/api/v1/__drill')).status).toBe(200);
      await fromEnv.close();
    } finally {
      for (const name of ['FAULT_INJECTION_ENABLED', 'FAULT_ADMIN_SUBJECTS', 'SYNTHETIC_SUBJECTS']) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }
  });
});

describe('fault injection on (dev)', () => {
  let app: INestApplication;
  let clock = new Date('2026-10-30T12:00:00Z');
  const metrics = pullMetrics();
  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false, fault: { enabled: true, adminSubjects: new Set(['drill-admin']), now: () => clock } });
    await app.init();
  });
  afterEach(async () => {
    const admin = await signIn(app, 'drill-admin');
    await admin.post('/api/v1/__fault', { mode: 'off' }).expect(200);
    clock = new Date('2026-10-30T12:00:00Z');
  });
  afterAll(async () => {
    await app.close();
    await metrics.close();
  });

  it('the drill route answers a signed-in request 200 { ok: true } and an anonymous one 401', async () => {
    const user = await signIn(app, 'drill-reader');
    const res = await user.get('/api/v1/__drill');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((await request(app.getHttpServer()).get('/api/v1/__drill')).status).toBe(401);
    expect((await request(app.getHttpServer()).post('/api/v1/__fault').send({ mode: 'errors' })).status).toBe(401);
  });

  it('a subject outside FAULT_ADMIN_SUBJECTS gets 403, a team admin included; a listed subject needs the CSRF token', async () => {
    const teamAdmin = await signIn(app, 'team-admin');
    await teamAdmin.post('/api/v1/teams', { name: 'Fault team' }).expect(201);
    expect((await teamAdmin.post('/api/v1/__fault', { mode: 'errors' })).status).toBe(403);
    const admin = await signIn(app, 'drill-admin');
    const noCsrf = await request(app.getHttpServer()).post('/api/v1/__fault').set('cookie', admin.cookie).send({ mode: 'errors' });
    expect(noCsrf.status).toBe(403);
    const ok = await admin.post('/api/v1/__fault', { mode: 'errors', count: 1 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ mode: 'errors', remaining: 1 });
  });

  it('refuses a body that is not a known mode or a count outside 1 to 5,000', async () => {
    const admin = await signIn(app, 'drill-admin');
    for (const body of [{ mode: 'boom' }, { mode: 'errors', count: 0 }, { mode: 'errors', count: 5001 }, { mode: 'errors', count: 1.5 }, {}]) {
      expect((await admin.post('/api/v1/__fault', body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('errors with count 2 makes the next two drill requests 500 and the third 200, counted 5xx and synthetic="false"', async () => {
    const admin = await signIn(app, 'drill-admin');
    await admin.post('/api/v1/__fault', { mode: 'errors', count: 2 }).expect(200);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await admin.get('/api/v1/__drill')).status);
    expect(statuses).toEqual([500, 500, 200]);
    const points = (await metrics.requests()).filter((p) => p.attributes.route === '/api/v1/__drill' && p.attributes.status_class === '5xx');
    expect(points).toEqual([{ attributes: { route: '/api/v1/__drill', method: 'GET', status_code: 500, status_class: '5xx', synthetic: 'false' }, value: 2 }]);
  });

  it('errors defaults to 500 requests', async () => {
    const admin = await signIn(app, 'drill-admin');
    expect((await admin.post('/api/v1/__fault', { mode: 'errors' })).body).toMatchObject({ mode: 'errors', remaining: 500 });
  });

  it('latency makes every drill request take at least 1.2 s, until off', async () => {
    const admin = await signIn(app, 'drill-admin');
    await admin.post('/api/v1/__fault', { mode: 'latency' }).expect(200);
    for (let i = 0; i < 2; i++) {
      const started = performance.now();
      expect((await admin.get('/api/v1/__drill')).status).toBe(200);
      expect(performance.now() - started).toBeGreaterThanOrEqual(1200);
    }
    await admin.post('/api/v1/__fault', { mode: 'off' }).expect(200);
    const started = performance.now();
    await admin.get('/api/v1/__drill').expect(200);
    expect(performance.now() - started).toBeLessThan(1200);
  });

  it('a fault set with a clock 61 minutes earlier is off', async () => {
    const admin = await signIn(app, 'drill-admin');
    await admin.post('/api/v1/__fault', { mode: 'errors', count: 5 }).expect(200);
    expect((await admin.get('/api/v1/__drill')).status).toBe(500);
    clock = new Date(clock.getTime() + 61 * 60_000);
    expect((await admin.get('/api/v1/__drill')).status).toBe(200);
  });
});

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { rawGet } from './support/raw-get.js';
import { fakeWebDist } from './support/web-dist.js';

describe('spa-fallback', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('serves index.html at / and at any client-side route', async () => {
    for (const path of ['/', '/work/42', '/teams']) {
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status, path).toBe(200);
      expect(res.text, path).toContain('<title>GetWorkDone</title>');
    }
  });

  it('serves built assets as files', async () => {
    const res = await request(app.getHttpServer()).get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.text).toContain('console.log');
  });

  it('a missing asset is a 404, not index.html', async () => {
    for (const path of ['/assets/missing.js', '/favicon.ico']) {
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status, path).toBe(404);
      expect(res.text, path).not.toContain('<title>');
    }
  });

  it('index.html is served with no-cache, so a new deploy is picked up', async () => {
    const res = await request(app.getHttpServer()).get('/work/1');
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('never falls back under /api/ or /__r4c/: an unknown path there is a JSON 404', async () => {
    for (const path of ['/api', '/api/nope', '/api/a/b', '/__r4c', '/__r4c/widget.js', '/__r4c/']) {
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers['content-type'], path).toContain('application/json');
      expect(res.text, path).not.toContain('<title>');
    }
  });

  it('repeated leading slashes do not reach the SPA: //api/v1 is 401, other //api and //__r4c paths a JSON 404 (GWP#15)', async () => {
    const expected: [string, number][] = [['//api/v1/me', 401], ['///api/v1/teams/x/work-types', 401], ['//api/x', 404], ['//api', 404], ['//__r4c/', 404]];
    for (const [path, status] of expected) {
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status, path).toBe(status);
      expect(res.headers['content-type'], path).toContain('application/json');
      expect(res.text, path).not.toContain('<title>');
    }
  });

  it('encoded, dot-segment and backslash spellings of /api do not reach the SPA: /api/v1 is 401, other /api and /__r4c paths a JSON 404 (GWP#30)', async () => {
    const expected: [string, number][] = [
      ['/%2Fapi/v1/me', 401],
      ['/%2fapi/v1/me', 401],
      ['/api%2Fv1/me', 401],
      ['/%61pi/v1/me', 401],
      ['/./api/v1/me', 401],
      ['/x/../api/v1/me', 401],
      ['/\\api/v1/me', 401],
      ['/x/%2E%2E/api/v1/me', 401],
      ['/%5Capi/v1/me', 401],
      ['/%2Fapi/v10', 404],
      ['/./api/x', 404],
      ['/%5F_r4c/', 404],
      ['/x/../__r4c/widget', 404],
    ];
    for (const [path, status] of expected) {
      const res = await rawGet(app.getHttpServer(), path);
      expect(res.status, path).toBe(status);
      expect(res.contentType, path).toContain('application/json');
      expect(res.text, path).not.toContain('<title>');
    }
  });

  it('a client-side route spelled with dot segments or escapes still loads the SPA (GWP#30)', async () => {
    for (const path of ['/x/../teams', '/%74eams/1', '/apis/x']) {
      const res = await rawGet(app.getHttpServer(), path);
      expect(res.status, path).toBe(200);
      expect(res.text, path).toContain('<title>GetWorkDone</title>');
    }
  });
});

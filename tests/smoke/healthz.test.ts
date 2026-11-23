import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { fakeWebDist } from '../../apps/api/test/support/web-dist.js';

// The harness's first test: boot the Nest app as main.ts does and get 200 from /healthz.
describe('smoke', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET /healthz returns 200 with status ok', async () => {
    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

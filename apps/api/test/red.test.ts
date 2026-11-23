import { Controller, Get, HttpCode, Module, NotFoundException, Post, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pullMetrics } from './support/metrics.js';
import { fakeWebDist } from './support/web-dist.js';

@Controller('api/cases')
class CasesController {
  @Get('ok')
  ok(): { ok: true } {
    return { ok: true };
  }

  @Post('created')
  created(): { ok: true } {
    return { ok: true };
  }

  @Post('accepted')
  @HttpCode(202)
  accepted(): void {}

  @Get('boom')
  boom(): never {
    throw new Error('handler failed');
  }

  @Get('unserializable')
  unserializable(): { n: bigint } {
    return { n: BigInt(1) };
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException();
  }
}

@Module({ controllers: [CasesController] })
class CasesModule {}

// Partition unit: each request is recorded exactly once, with its final status.
describe('RED metrics', () => {
  let app: INestApplication;
  const metrics = pullMetrics();
  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false, extraModules: [CasesModule] });
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await metrics.close();
  });

  async function point(route: string) {
    return (await metrics.requests()).filter((p) => p.attributes.route === route);
  }

  it('records 200, 201 and an explicit @HttpCode once each, by route pattern', async () => {
    const http = request(app.getHttpServer());
    await http.get('/api/cases/ok').expect(200);
    await http.post('/api/cases/created').expect(201);
    await http.post('/api/cases/accepted').expect(202);
    expect(await point('/api/cases/ok')).toEqual([{ attributes: { route: '/api/cases/ok', method: 'GET', status_code: 200, status_class: '2xx', synthetic: 'false' }, value: 1 }]);
    expect((await point('/api/cases/created'))[0]?.attributes.status_code).toBe(201);
    expect((await point('/api/cases/accepted'))[0]?.attributes.status_code).toBe(202);
  });

  it('a thrown HttpException records its own status (4xx)', async () => {
    await request(app.getHttpServer()).get('/api/cases/missing').expect(404);
    expect(await point('/api/cases/missing')).toEqual([{ attributes: { route: '/api/cases/missing', method: 'GET', status_code: 404, status_class: '4xx', synthetic: 'false' }, value: 1 }]);
  });

  it('a thrown plain Error records 500 (5xx), never 2xx', async () => {
    await request(app.getHttpServer()).get('/api/cases/boom').expect(500);
    expect(await point('/api/cases/boom')).toEqual([{ attributes: { route: '/api/cases/boom', method: 'GET', status_code: 500, status_class: '5xx', synthetic: 'false' }, value: 1 }]);
  });

  it('a response that fails to serialize is recorded once, as 500 (review of GWP#1)', async () => {
    await request(app.getHttpServer()).get('/api/cases/unserializable').expect(500);
    await new Promise((r) => setTimeout(r, 20));
    expect(await point('/api/cases/unserializable')).toEqual([{ attributes: { route: '/api/cases/unserializable', method: 'GET', status_code: 500, status_class: '5xx', synthetic: 'false' }, value: 1 }]);
  });

  it('a malformed JSON body on an API route is a 400, not a 404 (review of GWP#1)', async () => {
    const res = await request(app.getHttpServer()).post('/api/cases/created').set('content-type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect((await point('unmatched')).some((p) => p.attributes.status_code === 404 && p.attributes.method === 'POST')).toBe(false);
    expect((await metrics.requests()).some((p) => p.attributes.status_code === 400)).toBe(true);
  });

  it('SPA page loads are recorded under route "spa"', async () => {
    await request(app.getHttpServer()).get('/teams/7').expect(200);
    expect((await point('spa'))[0]?.attributes).toMatchObject({ method: 'GET', status_code: 200, status_class: '2xx' });
  });

  it('a request no route matched is recorded under route "unmatched", never its raw URL', async () => {
    await request(app.getHttpServer()).get('/api/no/such/route/123').expect(404);
    const unmatched = await point('unmatched');
    expect(unmatched.find((p) => p.attributes.status_code === 404)?.attributes).toMatchObject({ method: 'GET', status_class: '4xx' });
    expect((await metrics.requests()).some((p) => String(p.attributes.route).includes('123'))).toBe(false);
  });
});

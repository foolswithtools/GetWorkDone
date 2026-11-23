import { Controller, Get, HttpException, Module, type INestApplication } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { signIn } from './support/identity.js';
import { pullMetrics } from './support/metrics.js';
import { fakeWebDist } from './support/web-dist.js';

@Controller('api/red')
class ThrowingController {
  @Get('boom')
  boom(): never {
    throw new Error('handler failed');
  }

  @Get('ok')
  ok(): string {
    return 'ok';
  }

  @Get('http-500')
  http500(): never {
    throw new HttpException('upstream failed', 500);
  }
}

@Module({ controllers: [ThrowingController] })
class ThrowingModule {}

// The exemplar read res.statusCode in the interceptor's error path, before the exception filter set
// it, so a handler that threw was counted as 2xx (red.interceptor.ts:40, :56-59 @ 12a071e;
// prebutton.md:346). The status is now recorded by the final exception filter.
describe('RED status', () => {
  let app: INestApplication;
  const metrics = pullMetrics();
  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false, extraModules: [ThrowingModule], syntheticSubjects: new Set(['k6-probe']) });
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await metrics.close();
  });

  it('a handler throwing a 500 records status_class="5xx" in http_server_requests_total, never 2xx', async () => {
    for (const path of ['/api/red/boom', '/api/red/http-500']) {
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status, path).toBe(500);
    }
    const points = (await metrics.requests()).filter((p) => String(p.attributes.route).startsWith('/api/red/'));
    expect(points).toEqual(expect.arrayContaining([
      { attributes: { route: '/api/red/boom', method: 'GET', status_code: 500, status_class: '5xx', synthetic: 'false' }, value: 1 },
      { attributes: { route: '/api/red/http-500', method: 'GET', status_code: 500, status_class: '5xx', synthetic: 'false' }, value: 1 },
    ]));
    expect(points.filter((p) => p.attributes.status_class === '2xx')).toEqual([]);
    expect(points).toHaveLength(2);
  });

  // The SLO selectors keep synthetic="false" (GWP#7). GWP#9: probe traffic is the signed-in identity of a
  // subject in SYNTHETIC_SUBJECTS (here `k6-probe`), never a header any client can send.
  it('a request from a subject in SYNTHETIC_SUBJECTS records synthetic="true" on both recording paths; the x-synthetic header is ignored', async () => {
    const probe = await signIn(app, 'k6-probe');
    const person = await signIn(app, 'red-person');
    for (const path of ['/api/red/ok', '/api/red/boom']) await probe.get(path);
    await person.get('/api/red/ok').set('x-synthetic', 'true');
    await request(app.getHttpServer()).get('/api/red/ok').set('x-synthetic', 'true');
    const points = (await metrics.requests()).filter((p) => p.attributes.route === '/api/red/ok' || (p.attributes.route === '/api/red/boom' && p.attributes.synthetic === 'true'));
    expect(points).toEqual(expect.arrayContaining([
      { attributes: { route: '/api/red/ok', method: 'GET', status_code: 200, status_class: '2xx', synthetic: 'true' }, value: 1 },
      // The header from a subject outside the list, and from an anonymous request: both synthetic="false".
      { attributes: { route: '/api/red/ok', method: 'GET', status_code: 200, status_class: '2xx', synthetic: 'false' }, value: 2 },
      { attributes: { route: '/api/red/boom', method: 'GET', status_code: 500, status_class: '5xx', synthetic: 'true' }, value: 1 },
    ]));
    expect(points).toHaveLength(3);
  });
});

// GWP#58: the Alloy sidecar's tail sampler keeps 5 percent of synthetic traces and 20 percent of the
// rest. The request span says which through gwd.synthetic, set from the same isSynthetic the RED label
// uses, so the header is ignored there too.
describe('request span gwd.synthetic', () => {
  let app: INestApplication;
  const spans = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
  beforeAll(async () => {
    trace.setGlobalTracerProvider(provider);
    app = await createApp({ webDistDir: fakeWebDist(), logger: false, extraModules: [ThrowingModule], syntheticSubjects: new Set(['k6-probe']) });
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await provider.shutdown();
    trace.disable();
  });

  it('a request from a subject in SYNTHETIC_SUBJECTS has gwd.synthetic = true on its server span; one with only the x-synthetic header has none', async () => {
    const probe = await signIn(app, 'k6-probe');
    const person = await signIn(app, 'red-person');
    spans.reset();
    await probe.get('/api/red/ok');
    await new Promise((r) => setTimeout(r, 20));
    const probeSpans = spans.getFinishedSpans().filter((s) => s.name === 'GET /api/red/ok');
    expect(probeSpans.map((s) => s.attributes['gwd.synthetic'])).toEqual([true]);

    spans.reset();
    await person.get('/api/red/ok').set('x-synthetic', 'true');
    await request(app.getHttpServer()).get('/api/red/ok').set('x-synthetic', 'true');
    await new Promise((r) => setTimeout(r, 20));
    const others = spans.getFinishedSpans().filter((s) => s.name === 'GET /api/red/ok');
    expect(others).toHaveLength(2);
    for (const span of others) expect(span.attributes).not.toHaveProperty('gwd.synthetic');
  });
});

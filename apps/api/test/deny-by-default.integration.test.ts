import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { fakeWebDist } from './support/web-dist.js';

interface RouteLayer { route?: { path: string; methods: Record<string, boolean> } }

/** Every route the Express router holds after init: what the app actually serves. */
function registeredRoutes(app: INestApplication): { method: string; path: string }[] {
  const express = app.getHttpAdapter().getInstance() as { router: { stack: RouteLayer[] } };
  return express.router.stack.flatMap((layer) => layer.route
    ? Object.keys(layer.route.methods).filter((m) => layer.route!.methods[m]).map((method) => ({ method: method.toUpperCase(), path: layer.route!.path }))
    : []);
}

// GWP#3 supplies the verified identity. Until then, and whenever it is missing, every /api/v1 route
// answers 401, so a deploy (GWP#8) that lands before sign-in exposes nothing.
describe('deny by default', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
  });
  afterAll(() => app.close());

  it('every registered route under /api/v1 answers 401 without an identity', async () => {
    const routes = registeredRoutes(app).filter((r) => r.path.startsWith('/api/v1'));
    // The enumeration must find the routes this slice adds, or the loop below proves nothing.
    expect(routes).toEqual(expect.arrayContaining([
      { method: 'GET', path: '/api/v1/teams' },
      { method: 'POST', path: '/api/v1/teams' },
      { method: 'GET', path: '/api/v1/teams/:teamId/work-types' },
      { method: 'POST', path: '/api/v1/teams/:teamId/work-types' },
      { method: 'GET', path: '/api/v1/teams/:teamId/items/:itemId' },
    ]));
    for (const { method, path } of routes) {
      const url = path.replace(/:\w+/g, '00000000-0000-4000-8000-000000000000');
      const res = await request(app.getHttpServer())[method.toLowerCase() as 'get' | 'post'](url).send({});
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('a GET of an unknown path under /api/v1 is 401 too, not the SPA', async () => {
    await request(app.getHttpServer()).get('/api/v1/nothing-here').expect(401);
  });

  it('/healthz and the SPA stay open', async () => {
    await request(app.getHttpServer()).get('/healthz').expect(200);
    await request(app.getHttpServer()).get('/teams/some/client/route').expect(200);
  });
});

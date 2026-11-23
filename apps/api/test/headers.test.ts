import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from '../src/common/security-headers.js';
import { fakeWebDist } from './support/web-dist.js';

// Security response headers (GWP#48, docs/security.md): every response the API sends carries the same
// fixed set, the CSP included, whether a built file, the SPA, a Nest route or a guard's refusal answers.

const docsSecurity = new URL('../../../docs/security.md', import.meta.url);

describe('security-headers', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  const cases: { name: string; send: () => request.Test; status: number; type: string }[] = [
    { name: 'GET / (the SPA)', send: () => request(app.getHttpServer()).get('/'), status: 200, type: 'text/html' },
    { name: 'GET /work/42 (the SPA fallback)', send: () => request(app.getHttpServer()).get('/work/42'), status: 200, type: 'text/html' },
    { name: 'GET /assets/app.js (a built file)', send: () => request(app.getHttpServer()).get('/assets/app.js'), status: 200, type: 'javascript' },
    { name: 'HEAD /assets/app.js (a built file, as curl -I asks)', send: () => request(app.getHttpServer()).head('/assets/app.js'), status: 200, type: 'javascript' },
    // serve-static would answer a directory with a 301 whose CSP is its own default-src 'none'; with
    // redirect off it falls through to the SPA like /assets/.
    { name: 'GET /assets (a directory of built files)', send: () => request(app.getHttpServer()).get('/assets'), status: 200, type: 'text/html' },
    { name: 'GET /healthz', send: () => request(app.getHttpServer()).get('/healthz'), status: 200, type: 'application/json' },
    { name: 'GET /api/v1/me without a session (deny-by-default 401)', send: () => request(app.getHttpServer()).get('/api/v1/me'), status: 401, type: 'application/json' },
    { name: 'GET /api/nope (404)', send: () => request(app.getHttpServer()).get('/api/nope'), status: 404, type: 'application/json' },
    { name: 'POST /api/v1/teams without a session (401)', send: () => request(app.getHttpServer()).post('/api/v1/teams').send({ name: 'x' }), status: 401, type: 'application/json' },
    { name: 'POST /api/v1/teams with a malformed body (400 from the body parser)', send: () => request(app.getHttpServer()).post('/api/v1/teams').set('content-type', 'application/json').send('{'), status: 400, type: 'application/json' },
  ];

  for (const { name, send, status, type } of cases) {
    it(`${name} carries every security header with its exact value`, async () => {
      const res = await send();
      expect(res.status).toBe(status);
      expect(res.headers['content-type']).toContain(type);
      for (const [header, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers[header.toLowerCase()], header).toBe(value);
      expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers['content-security-policy-report-only']).toBeUndefined();
    });
  }

  it('sets the eight headers the issue lists, the CSP among them', () => {
    expect(Object.keys(SECURITY_HEADERS).map((h) => h.toLowerCase()).sort()).toEqual([
      'content-security-policy',
      'cross-origin-opener-policy',
      'cross-origin-resource-policy',
      'permissions-policy',
      'referrer-policy',
      'strict-transport-security',
      'x-content-type-options',
      'x-frame-options',
    ]);
    expect(SECURITY_HEADERS['Content-Security-Policy']).toBe(CONTENT_SECURITY_POLICY);
  });

  it('the policy forbids framing and admits no inline code, eval, wildcard or scheme source', () => {
    const directives = CONTENT_SECURITY_POLICY.split(';').map((d) => d.trim());
    expect(directives).toContain("frame-ancestors 'none'");
    expect(directives).toContain("script-src 'self'");
    expect(directives).toContain("connect-src 'self'");
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-inline');
    expect(CONTENT_SECURITY_POLICY).not.toContain('unsafe-eval');
    expect(CONTENT_SECURITY_POLICY).not.toContain('*');
    expect(CONTENT_SECURITY_POLICY).not.toContain('https:');
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/report-(uri|to)/);
  });

  it('docs/security.md holds the policy verbatim in its one ```csp block', () => {
    const blocks = [...readFileSync(docsSecurity, 'utf8').matchAll(/^```csp\n([\s\S]*?)\n```$/gm)].map((m) => m[1]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toBe(CONTENT_SECURITY_POLICY);
  });
});

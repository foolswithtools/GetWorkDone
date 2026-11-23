import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { fakeCollector, type Received } from '../../packages/telemetry/src/test-support/collector.js';
import { CONTENT_SECURITY_POLICY } from '../../apps/api/src/common/security-headers.js';
import { expectNoCspViolations, watchCsp } from './support/csp.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

const RESOURCE = {
  'service.name': 'getworkdone-api',
  'service.version': 'e2e-sha',
  'deployment.environment': 'e2e',
  'prebutton.instance': 'getworkdone-e2e',
};

interface OtlpKeyValue { key: string; value: { stringValue?: string } }
interface OtlpResource { attributes?: OtlpKeyValue[] }
interface OtlpSpan { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number }

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

function resourceAttributes(resource: OtlpResource | undefined): Record<string, string | undefined> {
  return Object.fromEntries((resource?.attributes ?? []).map((a) => [a.key, a.value.stringValue]));
}

function bodies(received: Received[], path: string): Record<string, unknown>[] {
  return received.filter((r) => r.path === path).map((r) => JSON.parse(r.body) as Record<string, unknown>);
}

let collector: Awaited<ReturnType<typeof fakeCollector>>;
let api: ChildProcess;
let baseURL: string;
let apiOutput = '';

test.beforeAll(async () => {
  collector = await fakeCollector();
  const port = await freePort();
  baseURL = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
    GETWORKDONE_VERSION: RESOURCE['service.version'],
    GETWORKDONE_ENVIRONMENT: RESOURCE['deployment.environment'],
    GETWORKDONE_INSTANCE: RESOURCE['prebutton.instance'],
  };
  delete env.OTEL_SDK_DISABLED;
  api = spawn(process.execPath, ['apps/api/dist/main.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout?.on('data', (d: Buffer) => (apiOutput += d.toString()));
  api.stderr?.on('data', (d: Buffer) => (apiOutput += d.toString()));
  await expect.poll(async () => (await fetch(`${baseURL}/healthz`).catch(() => undefined))?.status, { timeout: 20_000, message: apiOutput }).toBe(200);
});

test.afterAll(async () => {
  if (api.exitCode === null) api.kill('SIGKILL');
  await collector.close();
});

test('/ shows GetWorkDone, and the API span joins the browser traceparent trace', async ({ page }) => {
  watchCsp(page);
  const healthRequest = page.waitForRequest((r) => new URL(r.url()).pathname === '/healthz');
  const navigation = await page.goto(`${baseURL}/`);
  await expect(page).toHaveTitle('GetWorkDone');
  await expect(page.getByRole('heading', { name: 'GetWorkDone' })).toBeVisible();
  await expect(page.getByTestId('api-health')).toHaveText('ok');

  // GWP#48: the page arrives under the CSP and HSTS, the built page has no inline script (so
  // script-src 'self' needs no nonce), and the signed-out page breaks no directive.
  const headers = navigation!.headers();
  expect(headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
  expect(headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  // A string expression: the e2e tsconfig has no DOM lib.
  expect(await page.evaluate('document.querySelectorAll("script:not([src])").length')).toBe(0);
  expectNoCspViolations();

  const traceparent = (await healthRequest).headers()['traceparent'] ?? '';
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(traceparent);
  expect(match, `traceparent "${traceparent}"`).not.toBeNull();
  const [, browserTraceId, browserSpanId] = match!;

  // SIGTERM flushes every buffered span, metric and log record to the collector before exit.
  const exited = new Promise((resolve) => api.once('exit', resolve));
  api.kill('SIGTERM');
  await exited;

  const traces = bodies(collector.received, '/v1/traces') as { resourceSpans: { resource: OtlpResource; scopeSpans: { spans: OtlpSpan[] }[] }[] }[];
  const spans = traces.flatMap((t) => t.resourceSpans).flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans.map((span) => ({ span, resource: rs.resource }))));
  const apiSpan = spans.find(({ span }) => span.name === 'GET /healthz' && span.traceId === browserTraceId);
  expect(apiSpan, `spans: ${JSON.stringify(spans.map((s) => s.span))}`).toBeDefined();
  expect(apiSpan!.span.parentSpanId).toBe(browserSpanId);

  // Every exported span, metric and log record carries the four resource attributes.
  expect(spans.length).toBeGreaterThan(0);
  for (const { resource } of spans) expect(resourceAttributes(resource)).toMatchObject(RESOURCE);
  const metrics = bodies(collector.received, '/v1/metrics') as { resourceMetrics: { resource: OtlpResource }[] }[];
  expect(metrics.length).toBeGreaterThan(0);
  for (const rm of metrics.flatMap((m) => m.resourceMetrics)) expect(resourceAttributes(rm.resource)).toMatchObject(RESOURCE);
  const logs = bodies(collector.received, '/v1/logs') as { resourceLogs: { resource: OtlpResource; scopeLogs: { logRecords: { traceId?: string; body?: { stringValue?: string } }[] }[] }[] }[];
  const resourceLogs = logs.flatMap((l) => l.resourceLogs);
  expect(resourceLogs.length).toBeGreaterThan(0);
  for (const rl of resourceLogs) expect(resourceAttributes(rl.resource)).toMatchObject(RESOURCE);

  // The request's log line is correlated with the same trace (D-044).
  const records = resourceLogs.flatMap((rl) => rl.scopeLogs.flatMap((sl) => sl.logRecords));
  expect(records.some((r) => r.traceId === browserTraceId && r.body?.stringValue === 'request')).toBe(true);

  // GWP#58: with the OTLP log exporter built, stdout (CloudWatch's copy) carries warn and above plus the
  // startup line, and every stdout line carries the four resource fields as Loki names them.
  const stdoutLines = apiOutput.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(stdoutLines.find((l) => l.msg === 'listening'), apiOutput).toMatchObject({ level: 'info', startup: true });
  for (const line of stdoutLines) {
    expect(line).toMatchObject({ service: 'getworkdone-api', service_version: 'e2e-sha', deployment_environment: 'e2e', prebutton_instance: 'getworkdone-e2e' });
    expect(['warn', 'error', 'fatal'].includes(line.level as string) || line.startup === true, JSON.stringify(line)).toBe(true);
  }
  expect(stdoutLines.some((l) => l.msg === 'request')).toBe(false);
});

import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { httpServerSpans } from './http.js';
import { forceFlushOtel, shutdownOtel, startOtel } from './otel.js';

const opts = { serviceName: 'getworkdone-api', serviceVersion: 'v', deploymentEnvironment: 'e', instanceName: 'i' };
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_ID = '00f067aa0ba902b7';

let spans: InMemorySpanExporter;
let server: Server | undefined;
const saved = process.env.OTEL_SDK_DISABLED;
beforeEach(() => {
  delete process.env.OTEL_SDK_DISABLED;
  spans = new InMemorySpanExporter();
  startOtel(opts, { spanExporter: spans });
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  await shutdownOtel();
  if (saved === undefined) delete process.env.OTEL_SDK_DISABLED;
  else process.env.OTEL_SDK_DISABLED = saved;
});

// A bare node:http server behind the middleware; `route` mimics Express setting req.route on a match.
async function serve(status: number, route?: string, options?: Parameters<typeof httpServerSpans>[0]): Promise<{ port: number; activeTraceIds: string[] }> {
  const middleware = httpServerSpans(options);
  const activeTraceIds: string[] = [];
  server = createServer((req, res) => {
    middleware(req, res, () => {
      activeTraceIds.push(trace.getSpan(context.active())?.spanContext().traceId ?? 'none');
      if (route) (req as unknown as { route: { path: string } }).route = { path: route };
      res.statusCode = status;
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { port: (server!.address() as AddressInfo).port, activeTraceIds };
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve());
    }).on('error', reject).end();
  });
}

describe('traceparent', () => {
  it('an inbound traceparent becomes the parent of the request span, active for the handler', async () => {
    const { port, activeTraceIds } = await serve(200, '/healthz');
    await get(port, '/healthz?x=1', { traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` });
    await new Promise((r) => setTimeout(r, 20));
    await forceFlushOtel();
    const [span] = spans.getFinishedSpans();
    expect(span?.spanContext().traceId).toBe(TRACE_ID);
    expect(span?.parentSpanContext?.spanId).toBe(PARENT_ID);
    expect(span?.kind).toBe(SpanKind.SERVER);
    expect(span?.name).toBe('GET /healthz');
    expect(span?.attributes).toMatchObject({ 'http.request.method': 'GET', 'http.route': '/healthz', 'http.response.status_code': 200, 'url.path': '/healthz' });
    expect(activeTraceIds).toEqual([TRACE_ID]);
  });

  it('without a traceparent the request starts a new trace; a 5xx sets the span status to error', async () => {
    const { port } = await serve(503);
    await get(port, '/nowhere');
    await new Promise((r) => setTimeout(r, 20));
    await forceFlushOtel();
    const [span] = spans.getFinishedSpans();
    expect(span?.spanContext().traceId).not.toBe(TRACE_ID);
    expect(span?.parentSpanContext).toBeUndefined();
    expect(span?.name).toBe('GET');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });
});

// GWP#58: the Alloy sidecar's tail sampler keeps a smaller share of synthetic traces. Synthetic is the
// API's own judgement (isSynthetic, apps/api/src/common/red.ts: a verified subject in SYNTHETIC_SUBJECTS,
// never a header), known only once the guard has run, so it is asked when the response finishes.
describe('gwd.synthetic', () => {
  async function spanFor(synthetic: ((req: unknown) => boolean) | undefined, headers: Record<string, string> = {}) {
    const { port } = await serve(200, '/api/v1/teams', synthetic ? { synthetic } : undefined);
    await get(port, '/api/v1/teams', headers);
    await new Promise((r) => setTimeout(r, 20));
    await forceFlushOtel();
    return spans.getFinishedSpans()[0];
  }

  it('a request the predicate calls synthetic produces a server span with gwd.synthetic = true, asked after the handler ran', async () => {
    // The handler sets req.route, as Express does on a match; the guard's identity is set before it too.
    const span = await spanFor((req) => (req as { route?: unknown }).route !== undefined);
    expect(span?.attributes['gwd.synthetic']).toBe(true);
  });

  it('a request the predicate does not call synthetic has no gwd.synthetic attribute', async () => {
    expect((await spanFor(() => false))?.attributes).not.toHaveProperty('gwd.synthetic');
  });

  it('without a predicate the attribute is absent, whatever the x-synthetic header says', async () => {
    expect((await spanFor(undefined, { 'x-synthetic': 'true' }))?.attributes).not.toHaveProperty('gwd.synthetic');
  });
});

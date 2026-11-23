import { ROOT_CONTEXT, TraceFlags, trace } from '@opentelemetry/api';
import { AggregationTemporality, InMemoryMetricExporter } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeCollector } from './test-support/collector.js';
import { ecsTaskId, forceFlushOtel, otelOptionsFromEnv, otelState, setupOtel, shutdownOtel, startOtel, type OtelOptions } from './otel.js';
import { recordHttpServerRequest } from './metrics.js';

const opts = {
  serviceName: 'getworkdone-api',
  serviceVersion: 'abc1234',
  deploymentEnvironment: 'getworkdone-dev',
  instanceName: 'getworkdone-dev',
};

const resourceAttributes = {
  'service.name': 'getworkdone-api',
  'service.version': 'abc1234',
  'deployment.environment': 'getworkdone-dev',
  'prebutton.instance': 'getworkdone-dev',
};

// CI sets OTEL_SDK_DISABLED=true for every step; each test sets the variables it depends on, so none
// of them passes vacuously with the SDK off.
const saved = { endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT, disabled: process.env.OTEL_SDK_DISABLED };
beforeEach(() => {
  delete process.env.OTEL_SDK_DISABLED;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});
afterEach(async () => {
  await shutdownOtel();
  for (const [key, value] of [['OTEL_EXPORTER_OTLP_ENDPOINT', saved.endpoint], ['OTEL_SDK_DISABLED', saved.disabled]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('resource-attributes', () => {
  it('an exported span carries service.name, service.version, deployment.environment and prebutton.instance', async () => {
    const spans = new InMemorySpanExporter();
    startOtel(opts, { spanExporter: spans });
    trace.getTracer('test').startSpan('work').end();
    await forceFlushOtel();
    const exported = spans.getFinishedSpans();
    expect(exported).toHaveLength(1);
    expect(exported[0]?.resource.attributes).toMatchObject(resourceAttributes);
  });

  it('an exported metric carries the same four resource attributes', async () => {
    const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    startOtel(opts, { metricExporter: metrics });
    recordHttpServerRequest({ route: '/healthz', method: 'GET', statusCode: 200, durationSeconds: 0.01 });
    await forceFlushOtel();
    const batches = metrics.getMetrics();
    expect(batches.length).toBeGreaterThan(0);
    expect(batches[0]?.resource.attributes).toMatchObject(resourceAttributes);
  });
});

describe('service-instance-id', () => {
  // Every API task of an environment shares prebutton.instance (the environment's name), so without a
  // per-process service.instance.id two tasks overlapping in a rolling deploy write one interleaved
  // series and every drop reads as a counter reset (GWP#86).
  async function exportedResource(options: OtelOptions = opts) {
    const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    startOtel(options, { metricExporter: metrics });
    recordHttpServerRequest({ route: '/healthz', method: 'GET', statusCode: 200, durationSeconds: 0.01 });
    await forceFlushOtel();
    const resource = metrics.getMetrics()[0]?.resource.attributes;
    await shutdownOtel();
    return resource;
  }

  it('an exported metric carries a service.instance.id, distinct between two started resources, beside the four required attributes', async () => {
    const first = await exportedResource();
    const second = await exportedResource();
    expect(first?.['service.instance.id']).toEqual(expect.any(String));
    expect(first?.['service.instance.id']).not.toBe('');
    expect(second?.['service.instance.id']).toEqual(expect.any(String));
    expect(second?.['service.instance.id']).not.toBe(first?.['service.instance.id']);
    expect(first).toEqual({ ...resourceAttributes, 'service.instance.id': first?.['service.instance.id'] });
  });

  it('uses the serviceInstanceId it is given', async () => {
    expect((await exportedResource({ ...opts, serviceInstanceId: 'task-1' }))?.['service.instance.id']).toBe('task-1');
  });
});

describe('ecsTaskId', () => {
  // A made-up ARN: a real one names the account (D-035), and only the trailing task id leaves this function.
  const taskArn = 'arn:aws:ecs:us-east-1:000000000000:task/getworkdone-dev/0123456789abcdef0123456789abcdef';
  const metadata = 'http://169.254.170.2/v4/0123456789abcdef0123456789abcdef-1234567890';

  it('reads the task id from the ECS task metadata endpoint', async () => {
    const urls: string[] = [];
    const fetch = async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ TaskARN: taskArn, Cluster: 'getworkdone-dev' }));
    };
    expect(await ecsTaskId({ ECS_CONTAINER_METADATA_URI_V4: metadata }, fetch)).toBe('0123456789abcdef0123456789abcdef');
    expect(urls).toEqual([`${metadata}/task`]);
  });

  it('is undefined outside ECS, without a request', async () => {
    const fetch = async () => {
      throw new Error('no request expected');
    };
    expect(await ecsTaskId({}, fetch)).toBeUndefined();
  });

  it('is undefined when the endpoint fails, answers non-2xx, or carries no TaskARN, so the random id is used', async () => {
    const env = { ECS_CONTAINER_METADATA_URI_V4: metadata };
    expect(await ecsTaskId(env, async () => {
      throw new Error('ECONNREFUSED');
    })).toBeUndefined();
    expect(await ecsTaskId(env, async () => new Response('nope', { status: 500 }))).toBeUndefined();
    expect(await ecsTaskId(env, async () => new Response('not json'))).toBeUndefined();
    expect(await ecsTaskId(env, async () => new Response(JSON.stringify({ Cluster: 'x' })))).toBeUndefined();
    expect(await ecsTaskId(env, async () => new Response(JSON.stringify({ TaskARN: 'arn:aws:ecs:us-east-1:000000000000:task/' })))).toBeUndefined();
  });

  it('gives up after its timeout', async () => {
    const env = { ECS_CONTAINER_METADATA_URI_V4: metadata };
    const fetch = (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
    expect(await ecsTaskId(env, fetch, 20)).toBeUndefined();
  });
});

describe('otlp-endpoint', () => {
  it('defaults to the Alloy sidecar at http://localhost:4318 (D-027)', () => {
    setupOtel(opts);
    expect(otelState()?.endpoint).toBe('http://localhost:4318');
    expect(otelState()?.exporters).toEqual(['traces', 'metrics', 'logs']);
  });

  it('honours OTEL_EXPORTER_OTLP_ENDPOINT and exports traces, metrics and logs to /v1/* there', async () => {
    const collector = await fakeCollector();
    try {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `${collector.endpoint}/`;
      setupOtel(opts);
      expect(otelState()?.endpoint).toBe(collector.endpoint);
      trace.getTracer('test').startSpan('work').end();
      recordHttpServerRequest({ route: '/healthz', method: 'GET', statusCode: 200, durationSeconds: 0.01 });
      const { logs } = await import('@opentelemetry/api-logs');
      logs.getLogger('test').emit({ body: 'hello' });
      await shutdownOtel();
    } finally {
      await collector.close();
    }
    expect(collector.received.map((r) => r.path).sort()).toEqual(['/v1/logs', '/v1/metrics', '/v1/traces']);
    for (const r of collector.received) {
      for (const value of Object.values(resourceAttributes)) expect(r.body).toContain(value);
      expect(r.body).toContain('prebutton.instance');
    }
  });

  it('OTEL_SDK_DISABLED=true builds no exporter at all', () => {
    process.env.OTEL_SDK_DISABLED = 'true';
    startOtel(opts, { spanExporter: new InMemorySpanExporter() });
    expect(otelState()?.exporters).toEqual([]);
    // Spans stay real in process, so log lines still carry trace ids.
    const span = trace.getTracer('test').startSpan('work');
    expect(span.isRecording()).toBe(true);
    span.end();
  });

  it('a second call is a no-op', () => {
    setupOtel(opts);
    setupOtel({ ...opts, serviceName: 'other' });
    expect(otelState()?.resource['service.name']).toBe('getworkdone-api');
  });

  it('shutdown and flush are safe before setup', async () => {
    await expect(forceFlushOtel()).resolves.toBeUndefined();
    await expect(shutdownOtel()).resolves.toBeUndefined();
  });
});

describe('otelOptionsFromEnv', () => {
  it('reads GETWORKDONE_VERSION, GETWORKDONE_ENVIRONMENT and GETWORKDONE_INSTANCE', () => {
    expect(otelOptionsFromEnv('getworkdone-api', { GETWORKDONE_VERSION: 'sha1', GETWORKDONE_ENVIRONMENT: 'getworkdone', GETWORKDONE_INSTANCE: 'getworkdone' }, 'host-1')).toEqual({
      serviceName: 'getworkdone-api', serviceVersion: 'sha1', deploymentEnvironment: 'getworkdone', instanceName: 'getworkdone',
    });
  });

  it('falls back to dev, local and the host name, so telemetry never stops the API from starting', () => {
    expect(otelOptionsFromEnv('getworkdone-api', { GETWORKDONE_VERSION: '' }, 'host-1')).toEqual({
      serviceName: 'getworkdone-api', serviceVersion: 'dev', deploymentEnvironment: 'local', instanceName: 'host-1',
    });
  });
});

// GWP#58: the facts the sampling design rests on (docs/observability.md, "Sampling"). The provider has
// no sampler of its own, so the SDK reads OTEL_TRACES_SAMPLER and OTEL_TRACES_SAMPLER_ARG, default
// parentbased_always_on. The SPA mints every traceparent with flags 01, sampled, so a parent-based
// ratio keeps every SPA-initiated trace: only a non-parent-based ratio, or the sidecar, cuts volume.
describe('trace sampling', () => {
  const savedSampler = { sampler: process.env.OTEL_TRACES_SAMPLER, arg: process.env.OTEL_TRACES_SAMPLER_ARG };
  afterEach(() => {
    for (const [key, value] of [['OTEL_TRACES_SAMPLER', savedSampler.sampler], ['OTEL_TRACES_SAMPLER_ARG', savedSampler.arg]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // A span under the SPA's traceparent: a remote parent with flags 01.
  async function exportedUnderSampledParent(sampler?: string, arg?: string): Promise<number> {
    if (sampler === undefined) delete process.env.OTEL_TRACES_SAMPLER;
    else process.env.OTEL_TRACES_SAMPLER = sampler;
    if (arg === undefined) delete process.env.OTEL_TRACES_SAMPLER_ARG;
    else process.env.OTEL_TRACES_SAMPLER_ARG = arg;
    const spans = new InMemorySpanExporter();
    startOtel(opts, { spanExporter: spans });
    const parent = trace.setSpanContext(ROOT_CONTEXT, { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', traceFlags: TraceFlags.SAMPLED, isRemote: true });
    trace.getTracer('test').startSpan('GET /api/v1/teams', {}, parent).end();
    await forceFlushOtel();
    return spans.getFinishedSpans().length;
  }

  it('with the default sampler a span under a sampled remote parent is exported', async () => {
    expect(await exportedUnderSampledParent()).toBe(1);
  });

  it('with OTEL_TRACES_SAMPLER=traceidratio and OTEL_TRACES_SAMPLER_ARG=0 it is not, whatever the parent says', async () => {
    expect(await exportedUnderSampledParent('traceidratio', '0')).toBe(0);
  });

  it('with parentbased_traceidratio at 0 it still is: the SPA\'s flag 01 defeats a parent-based ratio', async () => {
    expect(await exportedUnderSampledParent('parentbased_traceidratio', '0')).toBe(1);
  });
});

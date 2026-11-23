// OpenTelemetry bootstrap, ported from the exemplar-shop (packages/telemetry/src/otel.ts @ 12a071e).
//
// Differences from the exemplar (GWP#1, spec §4.3):
//   - The resource carries service.name, service.version, deployment.environment and
//     prebutton.instance, not only service.name (otel.ts:51 @ 12a071e).
//   - setupOtel takes OtelOptions instead of a bare service name (otel.ts:31 @ 12a071e).
//   - The resource also carries service.instance.id, one per process (GWP#86): prebutton.instance is the
//     environment's name, so without it every task of an environment writes the same metric series, and
//     two tasks overlapping in a rolling deploy interleave their cumulative counters on it, each drop
//     reading as a counter reset. It is the ECS task id (ecsTaskId) when main.ts finds one, else a
//     random UUID.
//   - Logs (D-044): an OTLP log exporter to the same endpoint (`/v1/logs`); the pino logger
//     (logger.ts) emits each record through it as well as to stdout.
//   - No NodeSDK and no auto-instrumentation: module patching needs a loader hook under ESM. The API's
//     request spans come from httpServerSpans (http.ts) instead.
//
// The endpoint stays OTEL_EXPORTER_OTLP_ENDPOINT, default http://localhost:4318 (otel.ts:22 @
// 12a071e): the Alloy sidecar shares the task network (D-027). OTEL_SDK_DISABLED=true builds no
// exporter; spans and metrics are still real in process, so log lines carry trace ids, but nothing
// leaves the process and logs go to stdout only.

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { context, metrics, propagation, trace, type Attributes } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
  type LogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, SimpleSpanProcessor, type SpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_INSTANCE_ID, ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface OtelOptions {
  serviceName: string;
  serviceVersion: string;
  deploymentEnvironment: string;
  instanceName: string;
  /** service.instance.id: this process's own id, so each task writes its own series. Default: a random UUID. */
  serviceInstanceId?: string;
}

/** Exporters that replace the OTLP ones, for tests: each is flushed on every record. */
export interface OtelExporters {
  spanExporter?: SpanExporter;
  metricExporter?: PushMetricExporter;
  logExporter?: LogRecordExporter;
}

/** The OTLP/HTTP base endpoint when nothing overrides it: the Alloy sidecar (D-027). */
export const DEFAULT_OTLP_ENDPOINT = 'http://localhost:4318';

type Signal = 'traces' | 'metrics' | 'logs';

interface Started {
  resource: Attributes;
  endpoint: string | undefined;
  exporters: Signal[];
  tracer: NodeTracerProvider;
  meter: MeterProvider;
  logger: LoggerProvider | undefined;
}

let started: Started | undefined;

function sdkDisabled(): boolean {
  return process.env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true';
}

function otlpBaseEndpoint(): string {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || DEFAULT_OTLP_ENDPOINT;
  return endpoint.replace(/\/+$/, '');
}

/**
 * The setupOtel options from the environment. Telemetry never stops the API from starting, so every
 * value has a default: version `dev`, environment `local`, instance the host name.
 */
export function otelOptionsFromEnv(serviceName: string, env: NodeJS.ProcessEnv, host: string = hostname()): OtelOptions {
  return {
    serviceName,
    serviceVersion: env.GETWORKDONE_VERSION || 'dev',
    deploymentEnvironment: env.GETWORKDONE_ENVIRONMENT || 'local',
    instanceName: env.GETWORKDONE_INSTANCE || host,
  };
}

/** How long ecsTaskId waits for the task metadata endpoint before the random id is used instead. */
const ECS_METADATA_TIMEOUT_MS = 1_000;

/**
 * The ECS task id (the last segment of the task ARN) from the task metadata endpoint v4, for
 * service.instance.id; undefined outside ECS or on any failure, so telemetry never stops the API from
 * starting. Only the id leaves this function: the ARN names the account (D-035).
 */
export async function ecsTaskId(
  env: NodeJS.ProcessEnv,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  timeoutMs: number = ECS_METADATA_TIMEOUT_MS,
): Promise<string | undefined> {
  const base = env.ECS_CONTAINER_METADATA_URI_V4?.trim();
  if (!base) return undefined;
  try {
    const response = await fetchFn(`${base.replace(/\/+$/, '')}/task`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return undefined;
    const { TaskARN } = (await response.json()) as { TaskARN?: unknown };
    if (typeof TaskARN !== 'string') return undefined;
    return TaskARN.split('/').at(-1) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start tracing, metrics and logs and register them globally, with W3C trace context propagation
 * and an async-hooks context manager. Idempotent: a second call is a no-op.
 */
export function setupOtel(opts: OtelOptions): void {
  startOtel(opts);
}

/** setupOtel with test exporters in place of the OTLP ones. OTEL_SDK_DISABLED=true still wins. */
export function startOtel(opts: OtelOptions, overrides: OtelExporters = {}): void {
  if (started) return;

  const attributes: Attributes = {
    [ATTR_SERVICE_NAME]: opts.serviceName,
    [ATTR_SERVICE_VERSION]: opts.serviceVersion,
    // The key the issue names; semconv's newer `deployment.environment.name` is still incubating.
    'deployment.environment': opts.deploymentEnvironment,
    'prebutton.instance': opts.instanceName,
    // Grafana Cloud's OTLP ingest maps it to the `instance` label (docs/observability.md).
    [ATTR_SERVICE_INSTANCE_ID]: opts.serviceInstanceId || randomUUID(),
  };
  const resource = resourceFromAttributes(attributes);

  const spanProcessors: SpanProcessor[] = [];
  const readers: MetricReader[] = [];
  const logProcessors: LogRecordProcessor[] = [];
  const exporters: Signal[] = [];
  let endpoint: string | undefined;
  const injected = Boolean(overrides.spanExporter || overrides.metricExporter || overrides.logExporter);

  if (!sdkDisabled() && injected) {
    if (overrides.spanExporter) spanProcessors.push(new SimpleSpanProcessor(overrides.spanExporter));
    if (overrides.metricExporter) readers.push(new PeriodicExportingMetricReader({ exporter: overrides.metricExporter, exportIntervalMillis: 60_000 }));
    if (overrides.logExporter) logProcessors.push(new SimpleLogRecordProcessor({ exporter: overrides.logExporter }));
    if (overrides.spanExporter) exporters.push('traces');
    if (overrides.metricExporter) exporters.push('metrics');
    if (overrides.logExporter) exporters.push('logs');
  } else if (!sdkDisabled()) {
    endpoint = otlpBaseEndpoint();
    spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })));
    readers.push(new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${endpoint}/v1/metrics`,
        // Cumulative temporality is what Prometheus-style backends expect for counters and histograms.
        temporalityPreference: AggregationTemporality.CUMULATIVE,
      }),
      exportIntervalMillis: 15_000,
    }));
    logProcessors.push(new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs` }) }));
    exporters.push('traces', 'metrics', 'logs');
  }

  const tracer = new NodeTracerProvider({ resource, spanProcessors });
  tracer.register();
  const meter = new MeterProvider({ resource, readers });
  metrics.setGlobalMeterProvider(meter);
  // With no log exporter the global logger provider stays the no-op one: logs go to stdout only.
  let logger: LoggerProvider | undefined;
  if (logProcessors.length > 0) {
    logger = new LoggerProvider({ resource, processors: logProcessors });
    logs.setGlobalLoggerProvider(logger);
  }

  started = { resource: attributes, endpoint, exporters, tracer, meter, logger };
}

/** What setupOtel built, for tests and the start log line; undefined before setupOtel. */
export function otelState(): Pick<Started, 'resource' | 'endpoint' | 'exporters'> | undefined {
  return started && { resource: started.resource, endpoint: started.endpoint, exporters: started.exporters };
}

/** Export everything buffered so far. Safe if never started. */
export async function forceFlushOtel(): Promise<void> {
  if (!started) return;
  const { tracer, meter, logger } = started;
  await Promise.allSettled([tracer.forceFlush(), meter.forceFlush(), logger?.forceFlush()]);
}

/** Flush and shut down tracing, metrics and logs (process exit, tests). Safe if never started. */
export async function shutdownOtel(): Promise<void> {
  if (!started) return;
  const { tracer, meter, logger } = started;
  started = undefined;
  await Promise.allSettled([tracer.shutdown(), meter.shutdown(), logger?.shutdown()]);
  trace.disable();
  metrics.disable();
  logs.disable();
  propagation.disable();
  context.disable();
}

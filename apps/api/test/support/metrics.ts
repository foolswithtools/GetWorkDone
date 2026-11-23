import { metrics } from '@opentelemetry/api';
import { AggregationTemporality, InMemoryMetricExporter, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { forceFlushOtel, shutdownOtel, startOtel } from '@getworkdone/telemetry';

class PullReader extends MetricReader {
  protected override async onForceFlush(): Promise<void> {}
  protected override async onShutdown(): Promise<void> {}
}

/** Registers a global MeterProvider the test reads counters (`http_server_requests_total` by default) from on demand. */
export function pullMetrics() {
  const reader = new PullReader();
  const provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  return {
    async counter(name: string): Promise<{ attributes: Record<string, unknown>; value: number }[]> {
      const { resourceMetrics } = await reader.collect();
      const counter = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name);
      return (counter?.dataPoints ?? []).map((p) => ({ attributes: p.attributes, value: p.value as number }));
    },
    requests(): Promise<{ attributes: Record<string, unknown>; value: number }[]> {
      return this.counter('http_server_requests_total');
    },
    async close(): Promise<void> {
      await provider.shutdown();
      metrics.disable();
    },
  };
}

/** The four resource attributes every record carries (D-044), as `exportedMetrics` starts them. */
export const RESOURCE_ATTRIBUTES = {
  'service.name': 'getworkdone-api',
  'service.version': 'test-version',
  'deployment.environment': 'getworkdone-test',
  'prebutton.instance': 'getworkdone-test-instance',
} as const;

/**
 * Starts the real telemetry (startOtel) with an in-memory metric exporter, so a test reads a metric as it
 * is exported, with its resource (GWP#55). CI sets OTEL_SDK_DISABLED=true for every step, under which
 * nothing is exported, so it is unset until close(), which shuts telemetry down and puts it back.
 */
export function exportedMetrics() {
  const disabled = process.env.OTEL_SDK_DISABLED;
  delete process.env.OTEL_SDK_DISABLED;
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  startOtel({ serviceName: RESOURCE_ATTRIBUTES['service.name'], serviceVersion: RESOURCE_ATTRIBUTES['service.version'], deploymentEnvironment: RESOURCE_ATTRIBUTES['deployment.environment'], instanceName: RESOURCE_ATTRIBUTES['prebutton.instance'] }, { metricExporter: exporter });
  return {
    /** The counter's data points and the resource of the export that carried it, after a flush. */
    async counter(name: string): Promise<{ resource: Record<string, unknown>; points: { attributes: Record<string, unknown>; value: number }[] }> {
      await forceFlushOtel();
      const batch = exporter.getMetrics().at(-1);
      const metric = batch?.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name);
      return { resource: batch?.resource.attributes ?? {}, points: (metric?.dataPoints ?? []).map((p) => ({ attributes: p.attributes, value: p.value as number })) };
    },
    async close(): Promise<void> {
      await shutdownOtel();
      if (disabled !== undefined) process.env.OTEL_SDK_DISABLED = disabled;
    },
  };
}

import { Writable } from 'node:stream';
import { context, trace } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeCollector } from './test-support/collector.js';
import { createLogger } from './logger.js';
import { forceFlushOtel, otelState, setupOtel, shutdownOtel, startOtel } from './otel.js';

const opts = {
  serviceName: 'getworkdone-api',
  serviceVersion: 'abc1234',
  deploymentEnvironment: 'getworkdone-dev',
  instanceName: 'getworkdone-dev',
};

function stdoutSink(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  let text = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  return { stream, lines: () => text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) };
}

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

describe('otel-logs', () => {
  it('a line logged inside an active span is exported once as an OTel log record with its trace_id, span_id and the four resource attributes (D-044)', async () => {
    const exporter = new InMemoryLogRecordExporter();
    startOtel(opts, { logExporter: exporter });
    const out = stdoutSink();
    const log = createLogger({}, out.stream);

    const span = trace.getTracer('test').startSpan('work');
    const { traceId, spanId } = span.spanContext();
    context.with(trace.setSpan(context.active(), span), () => {
      log.info({ route: '/healthz', status_code: 200 }, 'request done');
    });
    span.end();
    await forceFlushOtel();

    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.spanContext?.traceId).toBe(traceId);
    expect(record.spanContext?.spanId).toBe(spanId);
    expect(record.body).toBe('request done');
    expect(record.severityNumber).toBe(SeverityNumber.INFO);
    expect(record.severityText).toBe('info');
    expect(record.attributes).toMatchObject({ route: '/healthz', status_code: 200 });
    expect(record.resource.attributes).toMatchObject({
      'service.name': 'getworkdone-api',
      'service.version': 'abc1234',
      'deployment.environment': 'getworkdone-dev',
      'prebutton.instance': 'getworkdone-dev',
    });

    // The same line also went to stdout as JSON, carrying the same ids.
    expect(out.lines()).toEqual([expect.objectContaining({ msg: 'request done', level: 'info', trace_id: traceId, span_id: spanId })]);
  });

  it('the OTel copy is the scrubbed record, never the raw arguments', async () => {
    const exporter = new InMemoryLogRecordExporter();
    startOtel(opts, { logExporter: exporter });
    const log = createLogger({}, stdoutSink().stream);
    log.warn({ password: 'hunter2', header: 'Bearer abc.def' }, 'token ghp_abcdefghijklmnopqrstuvwxyz');
    await forceFlushOtel();
    const [record] = exporter.getFinishedLogRecords();
    expect(JSON.stringify(record?.attributes)).not.toContain('hunter2');
    expect(JSON.stringify(record?.attributes)).not.toContain('abc.def');
    expect(record?.body).toBe('token [REDACTED]');
    expect(record?.severityNumber).toBe(SeverityNumber.WARN);
    // Outside a span there is no span context to carry.
    expect(record?.spanContext).toBeUndefined();
  });

  it('with OTEL_SDK_DISABLED=true only stdout is written', async () => {
    const collector = await fakeCollector();
    const out = stdoutSink();
    try {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.endpoint;
      process.env.OTEL_SDK_DISABLED = 'true';
      setupOtel(opts);
      expect(otelState()?.exporters).toEqual([]);
      createLogger({}, out.stream).info('only to stdout');
      await shutdownOtel();
    } finally {
      await collector.close();
    }
    expect(collector.received).toEqual([]);
    expect(out.lines()).toEqual([expect.objectContaining({ msg: 'only to stdout' })]);
  });
});

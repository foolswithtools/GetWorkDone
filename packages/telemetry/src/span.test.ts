import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forceFlushOtel, shutdownOtel, startOtel } from './otel.js';
import { withSpan } from './span.js';

let spans: InMemorySpanExporter;
const saved = process.env.OTEL_SDK_DISABLED;
beforeEach(() => {
  delete process.env.OTEL_SDK_DISABLED;
  spans = new InMemorySpanExporter();
  startOtel({ serviceName: 's', serviceVersion: 'v', deploymentEnvironment: 'e', instanceName: 'i' }, { spanExporter: spans });
});
afterEach(async () => {
  await shutdownOtel();
  if (saved === undefined) delete process.env.OTEL_SDK_DISABLED;
  else process.env.OTEL_SDK_DISABLED = saved;
});

describe('withSpan', () => {
  it('returns the callback result and ends the span', async () => {
    await expect(withSpan('ok', async () => 42)).resolves.toBe(42);
    await forceFlushOtel();
    expect(spans.getFinishedSpans().map((s) => s.name)).toEqual(['ok']);
  });

  it('records a thrown error, sets status ERROR, ends the span and rethrows', async () => {
    await expect(withSpan('boom', () => { throw new Error('nope'); })).rejects.toThrow('nope');
    await expect(withSpan('str', () => { throw 'bare'; })).rejects.toBe('bare');
    await forceFlushOtel();
    const [boom, str] = spans.getFinishedSpans();
    expect(boom?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'nope' });
    expect(boom?.events.map((e) => e.name)).toEqual(['exception']);
    expect(str?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'bare' });
  });
});

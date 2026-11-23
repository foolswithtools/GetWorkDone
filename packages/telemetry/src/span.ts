// Span helper, ported as is from the exemplar-shop (packages/telemetry/src/span.ts:17 @ 12a071e).
//
// withSpan() starts a span, runs the callback inside its context, records any thrown exception,
// sets the span status, and always ends the span.

import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';

/** Tracer name; the instrumentation scope reported alongside manual spans. */
const TRACER_NAME = '@getworkdone/telemetry';

/**
 * Run `fn` inside a new active span named `name`. The span is ended in all paths; thrown errors
 * are recorded (recordException + ERROR status) and re-thrown so callers see the original error.
 */
export async function withSpan<T>(name: string, fn: (span: Span) => Promise<T> | T): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const span = tracer.startSpan(name);
  const ctx = trace.setSpan(context.active(), span);
  try {
    return await context.with(ctx, () => fn(span));
  } catch (err) {
    span.recordException(err instanceof Error ? err : { message: String(err) });
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    span.end();
  }
}

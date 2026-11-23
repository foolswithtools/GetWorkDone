// Server spans for the API, in place of the exemplar's auto-instrumentation (see otel.ts).
//
// httpServerSpans() is Connect-style middleware, registered first in apps/api/src/main.ts. It
// continues the caller's W3C `traceparent` (the SPA's fetch wrapper sends one), starts a SERVER span,
// runs the rest of the request inside it, and ends it when the response finishes, named after the
// matched route pattern (never the raw URL). This is how the API span shares the browser's trace id
// (prebutton.md:353).
//
// GWP#58: with a `synthetic` predicate, a request it accepts when the response finishes gets
// `gwd.synthetic = true` on its span; the attribute is absent otherwise. The Alloy sidecar's tail
// sampler (deploy/alloy/config.alloy) keeps a smaller share of those traces. The API passes isSynthetic
// (apps/api/src/common/red.ts), the same judgement as the RED metrics' synthetic label; it needs the
// guard's identity, so it is asked at the end, never at the start.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';

/** Tracer name; the instrumentation scope reported alongside request spans. */
const TRACER_NAME = '@getworkdone/telemetry';

type Next = (err?: unknown) => void;

export interface HttpServerSpanOptions {
  /** Asked once the response finishes; true sets gwd.synthetic = true on the request span. */
  synthetic?: (req: IncomingMessage) => boolean;
}

/** The span attribute the sidecar's sampling policies read. */
export const SYNTHETIC_ATTRIBUTE = 'gwd.synthetic';

/** The route pattern Express records on a matched request, if any. */
function matchedRoute(req: IncomingMessage): string | undefined {
  const route = (req as IncomingMessage & { route?: { path?: unknown } }).route;
  return typeof route?.path === 'string' ? route.path : undefined;
}

export function httpServerSpans({ synthetic }: HttpServerSpanOptions = {}): (req: IncomingMessage, res: ServerResponse, next: Next) => void {
  return (req, res, next) => {
    const method = req.method ?? 'GET';
    const parent = propagation.extract(ROOT_CONTEXT, req.headers);
    const span = trace.getTracer(TRACER_NAME).startSpan(method, {
      kind: SpanKind.SERVER,
      attributes: { 'http.request.method': method, 'url.path': (req.url ?? '/').split('?')[0] ?? '/' },
    }, parent);

    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      const route = matchedRoute(req);
      if (route) {
        span.updateName(`${method} ${route}`);
        span.setAttribute('http.route', route);
      }
      span.setAttribute('http.response.status_code', res.statusCode);
      if (synthetic?.(req)) span.setAttribute(SYNTHETIC_ATTRIBUTE, true);
      if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    };
    res.once('finish', end);
    res.once('close', end);

    context.with(trace.setSpan(parent, span), () => next());
  };
}

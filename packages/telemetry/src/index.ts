// @getworkdone/telemetry: OpenTelemetry setup, RED metrics, spans, the redacting logger and
// profiling, ported from the exemplar-shop @ 12a071e (GWP#1, spec §4.3).

export { DEFAULT_OTLP_ENDPOINT, ecsTaskId, forceFlushOtel, otelOptionsFromEnv, otelState, setupOtel, shutdownOtel, startOtel } from './otel.js';
export type { OtelExporters, OtelOptions } from './otel.js';
export { httpServerSpans, SYNTHETIC_ATTRIBUTE } from './http.js';
export type { HttpServerSpanOptions } from './http.js';
export { DELIVERY_BACKLOG_TIMEOUT_MS, HTTP_DURATION_BUCKETS, primeFailedDeliveries, recordDatabaseReady, recordDistributionDelivery, recordHttpServerRequest, recordProcessSweep, recordSessionPurge, registerDeliveryBacklog, statusClassFor } from './metrics.js';
export { withSpan } from './span.js';
export { createLogger, loggerOptions, REDACTED, scrubString, stdoutLevelFromEnv, teeDestination } from './logger.js';
export type { TeeOptions } from './logger.js';
export type { Logger } from 'pino';
export { startProfiling } from './profiling.js';
export type { ProfilingOptions } from './profiling.js';

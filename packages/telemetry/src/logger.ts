// Structured JSON logger, ported from the exemplar-shop (packages/telemetry/src/logger.ts @ 12a071e:
// the redaction patterns and sensitive keys at :25-35, the scrubbing formatter at :113).
//
//   - Every line is one JSON object on stdout with a label level (`"level":"warn"`).
//   - A line written inside a span carries its trace_id and span_id (pino `mixin`).
//   - Each line is also emitted as an OpenTelemetry log record (D-044) through the global logger
//     provider that setupOtel registers, with the line's trace_id and span_id as its span context and
//     the provider's four resource attributes. With OTEL_SDK_DISABLED=true no provider is registered
//     and only stdout is written.
//   - stdout can be cut to the lines at or above a level (GWP#58): CloudWatch Logs bills every stdout
//     byte, and Loki already holds every line through the OTel record. createLogger takes the level
//     from LOG_STDOUT_LEVEL, default `warn` once setupOtel has built the OTLP log exporter, and otherwise
//     every line the logger writes (its own level, LOG_LEVEL for the API, is then the only filter). A
//     LOG_STDOUT_LEVEL above `error` (`fatal`, `silent`) is capped at `error`, so error and fatal lines
//     always reach stdout (GWP#134). A line carrying `startup: true` always reaches stdout, so a task
//     that dies before its telemetry leaves a trace in CloudWatch. The logger's own level stays the
//     floor of both sinks.
//   - The resource fields a logger may be bound with (service_version, deployment_environment,
//     prebutton_instance, named as Loki promotes the resource attributes) are written to stdout only:
//     the OTel record carries them as resource attributes already.
//   - Values are scrubbed before emit: bearer values, `Authorization` header values written as text,
//     JWTs (the shape of OIDC ID tokens), the sign-in cookies, and OIDC authorization codes, PKCE
//     verifiers and tokens in a URL query, fragment or form body (GWP#3), anywhere in a string; and every value under a
//     sensitive key. The message string is scrubbed too
//     (`hooks.logMethod`), including one pino would take from a logged Error; the exemplar's formatter
//     covered fields only. Errors keep their type, message and stack, scrubbed. The OTel copy is built
//     from the scrubbed line, never from the raw arguments.
//
// The exemplar's card-number and email patterns belong to the shop and are not ported; its Clerk-key
// pattern (:20) is replaced by the JWT and OIDC authorization-code shapes; its sensitive keys (:25-35)
// are kept, `email` included, and the OIDC token keys and the session cookie are added. GitHub token
// shapes are kept (CI and request-4-change text).

import { pino, stdSerializers, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { Writable } from 'node:stream';
import { ROOT_CONTEXT, TraceFlags, context, trace } from '@opentelemetry/api';
import { SeverityNumber, logs, type AnyValueMap } from '@opentelemetry/api-logs';
import { otelState } from './otel.js';

/** Replacement written in place of any scrubbed value. */
export const REDACTED = '[REDACTED]';

// Bearer tokens in any string (Authorization headers, etc.).
const BEARER_REGEX = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
// JWT shapes: three base64url parts, the first a JSON header (`eyJ`); an unsigned JWT ends in a dot.
const JWT_REGEX = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
// GitHub tokens: installation (ghs_), personal (ghp_) and fine-grained personal (github_pat_).
const GITHUB_TOKEN_REGEX = /\b(?:gh[sp]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g;
// An Authorization header written as text (`Authorization: Basic ...`, `authorization=...`): the
// scheme and credentials up to the end of the value.
// A JSON-quoted key (`"authorization":"Basic ..."`) counts too.
const AUTHORIZATION_TEXT_REGEX = /\b((?:proxy-)?authorization"?\s*[:=]\s*"?)(?:(?:Basic|Bearer|Digest|Negotiate|DPoP)\s+)?[^\s,;"'&]+/gi;
// The sign-in cookies (GWP#3; `__Host-` prefixed since GWP#17) in a Cookie or Set-Cookie header
// written as text.
const SESSION_COOKIE_TEXT_REGEX = /\b((?:__Host-)?gwd_(?:session|login)=)[^\s;,"']+/g;
// OIDC authorization-code flow values in a URL query, fragment or form body: the code (opaque, any
// issuer's shape), the PKCE verifier, the client secret and the tokens. `state` is not a secret.
const OIDC_PARAM_REGEX = /([?&#](?:code|code_verifier|client_secret|id_token|access_token|refresh_token)=)[^&#\s"']+/gi;
const OIDC_PARAM_LEADING_REGEX = /^((?:code|code_verifier|client_secret|id_token|access_token|refresh_token)=)[^&#\s"']+/i;

/** Field names whose values are always fully redacted regardless of content. */
const SENSITIVE_KEYS = new Set([
  'email',
  'authorization',
  'auth',
  'token',
  'pan',
  'cardnumber',
  'card_number',
  'password',
  'secret',
  'cookie',
  'set-cookie',
  'private_key',
  'client_secret',
  // OIDC (GWP#3): the tokens and the PKCE verifier, and the sign-in cookies by name (keys are
  // compared lowercased, so `__Host-gwd_session` is `__host-gwd_session` here; GWP#17).
  'id_token',
  'access_token',
  'refresh_token',
  'code_verifier',
  'gwd_session',
  'gwd_login',
  '__host-gwd_session',
  '__host-gwd_login',
]);

/** Scrub sensitive substrings out of a single string value. */
export function scrubString(value: string): string {
  return value
    .replace(AUTHORIZATION_TEXT_REGEX, `$1${REDACTED}`)
    .replace(SESSION_COOKIE_TEXT_REGEX, `$1${REDACTED}`)
    .replace(BEARER_REGEX, REDACTED)
    .replace(JWT_REGEX, REDACTED)
    .replace(OIDC_PARAM_REGEX, `$1${REDACTED}`)
    .replace(OIDC_PARAM_LEADING_REGEX, `$1${REDACTED}`)
    .replace(GITHUB_TOKEN_REGEX, REDACTED);
}

/**
 * Recursively scrub a log payload: redact sensitive keys outright, and scan all string values
 * for token patterns. Guards against cycles.
 */
function scrubValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return REDACTED;
  seen.add(value);
  // An Error's message and stack are not own enumerable properties: serialize it first (type,
  // message, stack, own fields), as pino would, then scrub that.
  if (value instanceof Error) return scrubValue(stdSerializers.err(value), seen);

  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = scrubValue(child, seen);
  }
  return out;
}

/** trace_id and span_id of the active span, if there is one. */
function traceFields(): { trace_id?: string; span_id?: string } {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const { traceId, spanId } = span.spanContext();
  return { trace_id: traceId, span_id: spanId };
}

/**
 * pino options for every role's logger, also accepted by Fastify's `logger` option. `bindings` are
 * attached to every line.
 */
export function loggerOptions(bindings: Record<string, string> = {}): LoggerOptions {
  return {
    level: 'info',
    base: bindings,
    mixin: traceFields,
    // pino applies serializers after formatters.log, which has already serialized and scrubbed any
    // Error; the default err serializer would relabel that plain object as type "Object".
    serializers: { err: (value: unknown) => (value instanceof Error ? scrubValue(value, new WeakSet()) : value) },
    formatters: {
      level: (label) => ({ level: label }),
      // Scrub the whole merged object on its way out; covers bindings-free fields and the mixin.
      log: (obj) => scrubValue(obj, new WeakSet()) as Record<string, unknown>,
    },
    hooks: {
      logMethod(args, method) {
        // `log.error(err)`: pino would take the message from the Error after this hook, unscrubbed.
        // Pass it as { err } with the message scrubbed here instead.
        const [first, ...rest] = args;
        const normalised: unknown[] = first instanceof Error
          ? [{ err: first }, typeof rest[0] === 'string' ? rest[0] : first.message, ...rest.slice(typeof rest[0] === 'string' ? 1 : 0)]
          : args;
        const scrubbed = normalised.map((arg) => (typeof arg === 'string' ? scrubString(arg) : arg)) as Parameters<typeof method>;
        method.apply(this, scrubbed);
      },
    },
  };
}

/** Instrumentation scope of the OTel log records. */
const LOGGER_NAME = '@getworkdone/telemetry';

const SEVERITY: Record<string, SeverityNumber> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

const HEX_TRACE_ID = /^[0-9a-f]{32}$/;
const HEX_SPAN_ID = /^[0-9a-f]{16}$/;

/** Bindings that mirror the resource attributes: on stdout only, never repeated on the OTel record. */
const RESOURCE_FIELDS = new Set(['service_version', 'deployment_environment', 'prebutton_instance']);

/** Emit one parsed (already scrubbed) JSON line as an OTel log record. */
function emitOtelRecord(parsed: Record<string, unknown>): void {
  const { level, time, msg, trace_id: traceId, span_id: spanId, ...rest } = parsed;
  const attributes = Object.fromEntries(Object.entries(rest).filter(([key]) => !RESOURCE_FIELDS.has(key)));
  const label = typeof level === 'string' ? level : 'info';
  const linked = typeof traceId === 'string' && HEX_TRACE_ID.test(traceId) && typeof spanId === 'string' && HEX_SPAN_ID.test(spanId);
  logs.getLogger(LOGGER_NAME).emit({
    ...(typeof time === 'number' ? { timestamp: time } : {}),
    severityNumber: SEVERITY[label] ?? SeverityNumber.UNSPECIFIED,
    severityText: label,
    body: typeof msg === 'string' ? msg : '',
    attributes: attributes as AnyValueMap,
    ...(linked ? { context: trace.setSpanContext(ROOT_CONTEXT, { traceId, spanId, traceFlags: TraceFlags.SAMPLED, isRemote: false }) } : {}),
  });
}

const LEVEL_VALUES: Record<string, number> = pino.levels.values;

/** The value of `level` when it names a pino level, an own key only: `constructor` is not one (GWP#134). */
function levelValue(level: string): number | undefined {
  return Object.hasOwn(LEVEL_VALUES, level) ? LEVEL_VALUES[level] : undefined;
}

export interface TeeOptions {
  /**
   * The lowest level written to `out`; a line with `startup: true` is written whatever its level. A
   * function is read on every write. Absent: every line.
   */
  stdoutLevel?: string | (() => string);
}

/**
 * A pino destination that emits each line as an OTel log record and writes it to `out` (when its
 * level reaches `stdoutLevel`). It runs in process and synchronously, so no worker thread loses the
 * active context.
 */
export function teeDestination(out: NodeJS.WritableStream = process.stdout, { stdoutLevel }: TeeOptions = {}): DestinationStream {
  return new Writable({
    decodeStrings: false,
    write(chunk: string | Buffer, _encoding, done) {
      const threshold = levelValue(typeof stdoutLevel === 'function' ? stdoutLevel() : stdoutLevel ?? '') ?? 0;
      for (const line of chunk.toString().split('\n')) {
        if (!line) continue;
        let parsed: Record<string, unknown> | undefined;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          parsed = undefined;
        }
        if (parsed) emitOtelRecord(parsed);
        const value = parsed && typeof parsed.level === 'string' ? (levelValue(parsed.level) ?? 0) : Infinity;
        if (value >= threshold || parsed?.startup === true) out.write(`${line}\n`);
      }
      done();
    },
  });
}

/**
 * LOG_STDOUT_LEVEL when it names a level, capped at `error` (`fatal` and `silent` give `error`, so error
 * and fatal lines always reach stdout, GWP#134), else `warn` once setupOtel has built the OTLP log exporter
 * (Loki holds every line), else `trace`, every line the logger writes (local, CI, OTEL_SDK_DISABLED=true,
 * or before setupOtel).
 */
export function stdoutLevelFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const chosen = env.LOG_STDOUT_LEVEL?.trim().toLowerCase();
  if (chosen === 'fatal' || chosen === 'silent') return 'error';
  if (chosen && levelValue(chosen) !== undefined) return chosen;
  const state = otelState();
  return state?.endpoint !== undefined && state.exporters.includes('logs') ? 'warn' : 'trace';
}

/**
 * A JSON logger writing to OTel logs and to `destination` (stdout by default), the latter at
 * stdoutLevelFromEnv(), read on every line: the API creates its logger before main.ts calls setupOtel.
 */
export function createLogger(bindings?: Record<string, string>, destination?: NodeJS.WritableStream): Logger {
  return pino(loggerOptions(bindings), teeDestination(destination, { stdoutLevel: () => stdoutLevelFromEnv() }));
}

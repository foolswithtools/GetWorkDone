import { Writable } from 'node:stream';
import { context, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, loggerOptions, REDACTED, stdoutLevelFromEnv, teeDestination } from './logger.js';
import { forceFlushOtel, otelState, setupOtel, shutdownOtel, startOtel } from './otel.js';
import { fakeCollector } from './test-support/collector.js';

const OPTS = { serviceName: 'getworkdone-api', serviceVersion: 'abc1234', deploymentEnvironment: 'getworkdone-dev', instanceName: 'dev' };

// Collects every JSON line the logger writes.
function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      lines.push(...chunk.toString().split('\n').filter(Boolean));
      done();
    },
  });
  return { stream, lines, all: () => lines.join('\n'), last: () => JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown> };
}

// Joined at run time: the public snapshot's secret scan (gitleaks, #11) reads the source and honours no
// allow comment, so a fake token written whole would stop the publish (tests/publish/secret-shapes.test.ts).
const JWT = ['eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0', 'eyJzdWIiOiJ1c2VyLTEifQ', 'c2lnbmF0dXJlLXZhbHVl'].join('.');
const UNSIGNED_JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1In0.';
const GHS = ['ghs', '16C7e42F292c6912E7710c838347Ae178B4a'].join('_');
const GHP = ['ghp', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'].join('_');
const PAT = ['github', 'pat', '11ABCDEFG0123456789', 'abcdefghijklmnopqrstuvwxyz'].join('_');

describe('log-redaction', () => {
  it('redacts a JWT, a ghs_ token, a bearer header and a client_secret field', () => {
    const out = capture();
    const log = createLogger({}, out.stream);
    log.info({ assertion: `token ${JWT} rejected`, git: `https://x-access-token:${GHS}@github.com/o/r.git`, headers: { 'x-forwarded-authorization': 'Bearer abc.def-ghi' }, client_secret: 's3cr3t' }, 'seen');
    const line = out.all();
    expect(line).not.toContain(JWT);
    expect(line).not.toContain(GHS);
    expect(line).not.toContain('abc.def-ghi');
    expect(line).not.toContain('s3cr3t');
    expect(out.last().client_secret).toBe(REDACTED);
  });

  it('redacts an unsigned JWT, ghp_ and github_pat_ tokens', () => {
    const out = capture();
    createLogger({}, out.stream).warn({ a: UNSIGNED_JWT, b: GHP, c: [PAT] }, 'x');
    const line = out.all();
    for (const value of [UNSIGNED_JWT, GHP, PAT]) expect(line).not.toContain(value);
  });

  it('redacts the cookie, set-cookie, private_key and authorization keys whatever their value', () => {
    const out = capture();
    createLogger({}, out.stream).info({ cookie: 'sid=1', 'set-cookie': ['sid=2'], private_key: '-----BEGIN', nested: { Authorization: 'Basic eA==' } }, 'x');
    const line = out.last();
    expect(line.cookie).toBe(REDACTED);
    expect(line['set-cookie']).toBe(REDACTED);
    expect(line.private_key).toBe(REDACTED);
    expect(line.nested).toEqual({ Authorization: REDACTED });
  });

  it('scrubs the message string too, not only the fields', () => {
    const out = capture();
    createLogger({}, out.stream).error(`exchange failed for ${GHS}`);
    expect(out.all()).not.toContain(GHS);
    expect(out.last().msg).toBe(`exchange failed for ${REDACTED}`);
  });

  it('scrubs the message of an Error logged on its own, as Fastify logs a failed hook', () => {
    const out = capture();
    createLogger({}, out.stream).error(new Error(`exchange failed for ${GHS}`));
    expect(out.all()).not.toContain(GHS);
    expect(out.last().msg).toBe(`exchange failed for ${REDACTED}`);
    expect(out.last().err).toMatchObject({ type: 'Error', message: `exchange failed for ${REDACTED}` });
  });

  it('scrubs an Error under err and keeps its type, message and stack', () => {
    const out = capture();
    createLogger({}, out.stream).error({ err: new TypeError(`bad ${JWT}`) }, 'failed');
    expect(out.all()).not.toContain(JWT);
    const err = out.last().err as Record<string, unknown>;
    expect(err).toMatchObject({ type: 'TypeError', message: `bad ${REDACTED}` });
    expect(err.stack).toEqual(expect.stringContaining(`TypeError: bad ${REDACTED}`));
  });

  it('redacts a JWT and an Authorization header value, as a field and as free text (GWP#3)', () => {
    const out = capture();
    const log = createLogger({}, out.stream);
    log.info({ headers: { Authorization: `Bearer ${JWT}` }, raw: `Authorization: Basic Y2xpZW50OnNlY3JldA==`, id: JWT }, `retrying with authorization=Basic Y2xpZW50OnNlY3JldA==`);
    const line = out.all();
    expect(line).not.toContain('eyJ');
    expect(line).not.toContain('Y2xpZW50OnNlY3JldA==');
    expect(out.last()).toMatchObject({ raw: `Authorization: ${REDACTED}`, msg: `retrying with authorization=${REDACTED}` });
  });

  it('redacts OIDC authorization codes, PKCE verifiers and tokens in URLs and form bodies, and keeps state', () => {
    const out = capture();
    createLogger({}, out.stream).warn({
      url: '/auth/callback?code=SplxlOBeZQQYbYS6WxSbIA&state=af0ifjsldkj',
      body: 'grant_type=authorization_code&code=4%2F0AX4XfWh&redirect_uri=x&code_verifier=dBjftJeZ4CVP&client_secret=s3cr3t',
      fragment: 'https://app.example.test/#id_token=abc.def&access_token=opaque123&refresh_token=r1',
    }, 'callback');
    const line = out.all();
    for (const secret of ['SplxlOBeZQQYbYS6WxSbIA', '4%2F0AX4XfWh', 'dBjftJeZ4CVP', 's3cr3t', 'abc.def', 'opaque123', 'r1&', '=r1"']) expect(line, secret).not.toContain(secret);
    expect(out.last().url).toBe(`/auth/callback?code=${REDACTED}&state=af0ifjsldkj`);
  });

  it('redacts the sign-in cookies and an authorization value written as JSON text (branch review, GWP#3)', () => {
    const out = capture();
    createLogger({}, out.stream).info({ raw: 'Cookie: theme=dark; __Host-gwd_session=c2Vzc2lvbi10b2tlbg; __Host-gwd_login=bG9naW4' }, '{"authorization":"Basic Y2xpZW50OnNlY3JldA=="}');
    const line = out.all();
    for (const secret of ['c2Vzc2lvbi10b2tlbg', 'bG9naW4', 'Y2xpZW50OnNlY3JldA==']) expect(line, secret).not.toContain(secret);
    expect(out.last().raw).toBe(`Cookie: theme=dark; __Host-gwd_session=${REDACTED}; __Host-gwd_login=${REDACTED}`);
  });

  it('redacts the OIDC token keys and the sign-in cookie names whatever their value, but not status_code', () => {
    const out = capture();
    createLogger({}, out.stream).info({ id_token: 'x', access_token: 'y', refresh_token: 'z', code_verifier: 'v', '__Host-gwd_session': 's', '__Host-gwd_login': 'l', gwd_login: 'o', status_code: 403 }, 'x');
    expect(out.last()).toMatchObject({ id_token: REDACTED, access_token: REDACTED, refresh_token: REDACTED, code_verifier: REDACTED, '__Host-gwd_session': REDACTED, '__Host-gwd_login': REDACTED, gwd_login: REDACTED, status_code: 403 });
  });

  it('keeps ordinary fields such as a refusal reason', () => {
    const out = capture();
    createLogger({ service: 'getworkdone-api' }, out.stream).warn({ reason: 'missing_kid' }, 'invalid requester assertion');
    expect(out.last()).toMatchObject({ level: 'warn', service: 'getworkdone-api', reason: 'missing_kid', msg: 'invalid requester assertion' });
  });
});

describe('log correlation', () => {
  const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())] });
  beforeAll(() => provider.register());
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
  });

  it('a line written inside a span carries its trace_id and span_id', () => {
    const out = capture();
    const log = createLogger({}, out.stream);
    const span = trace.getTracer('t').startSpan('s');
    context.with(trace.setSpan(context.active(), span), () => log.info('inside'));
    span.end();
    expect(out.last()).toMatchObject({ trace_id: span.spanContext().traceId, span_id: span.spanContext().spanId });
  });

  it('a line written outside any span has no trace fields', () => {
    const out = capture();
    createLogger({}, out.stream).info('outside');
    expect(out.last()).not.toHaveProperty('trace_id');
  });
});

// GWP#58: the stdout copy is what CloudWatch Logs ingests and bills per GB; the OTel copy reaches Loki.
describe('stdout level', () => {
  // A shut-down in-memory exporter records nothing, so each test gets its own.
  let exporter = new InMemoryLogRecordExporter();
  const saved = { disabled: process.env.OTEL_SDK_DISABLED, endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT, level: process.env.LOG_STDOUT_LEVEL };
  beforeEach(() => {
    delete process.env.OTEL_SDK_DISABLED;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.LOG_STDOUT_LEVEL;
    exporter = new InMemoryLogRecordExporter();
  });
  afterEach(async () => {
    await shutdownOtel();
    for (const [key, value] of [['OTEL_SDK_DISABLED', saved.disabled], ['OTEL_EXPORTER_OTLP_ENDPOINT', saved.endpoint], ['LOG_STDOUT_LEVEL', saved.level]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const bodies = () => exporter.getFinishedLogRecords().map((r) => r.body);
  const msgs = (out: ReturnType<typeof capture>) => out.lines.map((l) => (JSON.parse(l) as { msg: string }).msg);

  it("teeDestination with stdoutLevel 'warn': an info line is an OTel record only, a warn line and an info line with startup: true go to both", async () => {
    startOtel(OPTS, { logExporter: exporter });
    const out = capture();
    const log = pino(loggerOptions(), teeDestination(out.stream, { stdoutLevel: 'warn' }));
    log.info('quiet');
    log.warn('loud');
    log.info({ startup: true }, 'listening');
    log.error('worse');
    await forceFlushOtel();
    expect(bodies()).toEqual(['quiet', 'loud', 'listening', 'worse']);
    expect(msgs(out)).toEqual(['loud', 'listening', 'worse']);
  });

  it('teeDestination without stdoutLevel writes every line to both, as before', async () => {
    startOtel(OPTS, { logExporter: exporter });
    const out = capture();
    const log = pino({ ...loggerOptions(), level: 'debug' }, teeDestination(out.stream));
    log.debug('a');
    log.info('b');
    await forceFlushOtel();
    expect(bodies()).toEqual(['a', 'b']);
    expect(msgs(out)).toEqual(['a', 'b']);
  });

  it('createLogger takes LOG_STDOUT_LEVEL; the logger level stays the floor for both sinks', async () => {
    startOtel(OPTS, { logExporter: exporter });
    process.env.LOG_STDOUT_LEVEL = 'error';
    const out = capture();
    const log = createLogger({}, out.stream);
    log.level = 'warn';
    log.info('below the floor');
    log.warn('otel only');
    log.error('both');
    await forceFlushOtel();
    expect(bodies()).toEqual(['otel only', 'both']);
    expect(msgs(out)).toEqual(['both']);
  });

  it('createLogger defaults to warn on stdout when the OTLP log exporter was built', async () => {
    const collector = await fakeCollector();
    try {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = collector.endpoint;
      setupOtel(OPTS);
      expect(otelState()?.exporters).toContain('logs');
      const out = capture();
      const log = createLogger({}, out.stream);
      log.info('request');
      log.info({ startup: true }, 'listening');
      log.warn('refused');
      expect(msgs(out)).toEqual(['listening', 'refused']);
      await shutdownOtel();
    } finally {
      await collector.close();
    }
  });

  it('createLogger writes every line to stdout with OTEL_SDK_DISABLED=true or before setupOtel', () => {
    const before = capture();
    createLogger({}, before.stream).info('before setup');
    expect(msgs(before)).toEqual(['before setup']);
    process.env.OTEL_SDK_DISABLED = 'true';
    setupOtel(OPTS);
    const out = capture();
    const log = createLogger({}, out.stream);
    log.level = 'debug';
    log.debug('debug');
    log.info('request');
    expect(msgs(out)).toEqual(['debug', 'request']);
  });

  it('an unknown LOG_STDOUT_LEVEL falls back to the default rather than dropping lines', () => {
    process.env.LOG_STDOUT_LEVEL = 'loud';
    const out = capture();
    createLogger({}, out.stream).info('kept');
    expect(msgs(out)).toEqual(['kept']);
  });

  // GWP#134: `in` matched Object.prototype's keys, so LOG_STDOUT_LEVEL=constructor dropped every line from stdout.
  it('LOG_STDOUT_LEVEL=constructor (an inherited key) falls back to the default, and error lines stay on stdout', () => {
    expect(stdoutLevelFromEnv({ LOG_STDOUT_LEVEL: 'constructor' })).toBe('trace');
    expect(stdoutLevelFromEnv({ LOG_STDOUT_LEVEL: 'toString' })).toBe('trace');
    process.env.LOG_STDOUT_LEVEL = 'constructor';
    const out = capture();
    const log = createLogger({}, out.stream);
    log.info('kept');
    log.error('also kept');
    expect(msgs(out)).toEqual(['kept', 'also kept']);
  });

  it('LOG_STDOUT_LEVEL fatal and silent cap at error, so error and fatal lines always reach stdout', () => {
    expect(stdoutLevelFromEnv({ LOG_STDOUT_LEVEL: 'fatal' })).toBe('error');
    expect(stdoutLevelFromEnv({ LOG_STDOUT_LEVEL: 'silent' })).toBe('error');
    expect(stdoutLevelFromEnv({ LOG_STDOUT_LEVEL: ' Error ' })).toBe('error');
    for (const level of ['fatal', 'silent']) {
      process.env.LOG_STDOUT_LEVEL = level;
      const out = capture();
      const log = createLogger({}, out.stream);
      log.warn('dropped');
      log.error('error');
      log.fatal('fatal');
      expect(msgs(out)).toEqual(['error', 'fatal']);
    }
  });

  it('teeDestination treats an inherited key as no stdoutLevel, writing every line', () => {
    const out = capture();
    const log = pino(loggerOptions(), teeDestination(out.stream, { stdoutLevel: 'constructor' }));
    log.info('a');
    log.error('b');
    expect(msgs(out)).toEqual(['a', 'b']);
  });

  it('a stdout line carries the four bindings; the OTel record leaves the resource ones to its resource', async () => {
    startOtel(OPTS, { logExporter: exporter });
    const out = capture();
    const bindings = { service: 'getworkdone-api', service_version: 'abc1234', deployment_environment: 'getworkdone-dev', prebutton_instance: 'dev' };
    createLogger(bindings, out.stream).warn({ password: 'hunter2' }, 'seen');
    await forceFlushOtel();
    expect(out.last()).toMatchObject({ ...bindings, password: REDACTED, msg: 'seen' });
    const [record] = exporter.getFinishedLogRecords();
    expect(record?.attributes).toEqual({ service: 'getworkdone-api', password: REDACTED });
  });
});

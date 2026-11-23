import { Writable } from 'node:stream';
import type { ArgumentsHost, CallHandler, ExecutionContext } from '@nestjs/common';
import { createLogger } from '@getworkdone/telemetry';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { FinalStatusFilter } from '../src/common/final-status.filter.js';
import { apiLoggerBindings, NestPinoLogger } from '../src/common/logger.js';
import { RedInterceptor } from '../src/common/red.interceptor.js';
import { routeLabel, secondsSinceStart } from '../src/common/red.js';
import { subjectsFromEnv } from '../src/common/subjects.js';
import { defaultWebDistDir } from '../src/app.js';
import { isReservedPath } from '../src/spa/spa.controller.js';

function sink() {
  let text = '';
  const stream = new Writable({ write(chunk: Buffer, _e, done) { text += chunk.toString(); done(); } });
  return { stream, lines: () => text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('NestPinoLogger', () => {
  it('maps every Nest log level onto the redacting pino logger, with the Nest context', () => {
    const out = sink();
    const logger = new NestPinoLogger(Object.assign(createLogger({}, out.stream), { level: 'trace' }));
    logger.log('started', 'NestFactory');
    logger.error('failed', 'stack here', 'ExceptionsHandler');
    logger.warn({ token: 'abc' }, 'Config');
    logger.debug('dbg');
    logger.verbose('verbose');
    expect(out.lines().map((l) => [l.level, l.msg, l.context])).toEqual([
      ['info', 'started', 'NestFactory'],
      ['error', 'failed', 'ExceptionsHandler'],
      ['warn', '{"token":"abc"}', 'Config'],
      ['debug', 'dbg', undefined],
      ['trace', 'verbose', undefined],
    ]);
    expect(out.lines()[1]?.stack).toBe('stack here');
  });
});

// GWP#58: a CloudWatch line and a Loki line carry the same field names (the resource attributes with
// dots turned into underscores, as Loki promotes them), so dev and prod lines differ by more than the log group.
describe('apiLoggerBindings', () => {
  it('binds service, service_version, deployment_environment and prebutton_instance from the environment', () => {
    const env = { GETWORKDONE_VERSION: 'abc1234', GETWORKDONE_ENVIRONMENT: 'getworkdone-dev', GETWORKDONE_INSTANCE: 'dev' };
    expect(apiLoggerBindings(env)).toEqual({ service: 'getworkdone-api', service_version: 'abc1234', deployment_environment: 'getworkdone-dev', prebutton_instance: 'dev' });
    const out = sink();
    createLogger(apiLoggerBindings(env), out.stream).warn('x');
    expect(out.lines()[0]).toMatchObject(apiLoggerBindings(env));
  });

  it('falls back like the resource attributes do: dev, local and the host name', () => {
    expect(apiLoggerBindings({}, 'host-1')).toEqual({ service: 'getworkdone-api', service_version: 'dev', deployment_environment: 'local', prebutton_instance: 'host-1' });
  });
});

describe('RED helpers', () => {
  it('an unstamped request has a zero duration; the SPA catch-all is "spa", or "unmatched" for a reserved path', () => {
    expect(secondsSinceStart({} as never)).toBe(0);
    expect(routeLabel({ route: { path: '/{*path}' }, path: '/teams/1' } as never)).toBe('spa');
    expect(routeLabel({ route: { path: '/{*path}' }, path: '/api/x' } as never)).toBe('unmatched');
    expect(routeLabel({ route: { path: '/{*path}' }, path: '//api/x' } as never)).toBe('unmatched');
    expect(routeLabel({ route: { path: '/{*path}' }, path: '/%2Fapi/x' } as never)).toBe('unmatched');
    expect(routeLabel({ route: { path: '/{*path}' }, path: '/x/../teams' } as never)).toBe('spa');
    expect(routeLabel({ route: { path: '/healthz' } } as never)).toBe('/healthz');
    expect(routeLabel({} as never)).toBe('unmatched');
  });

  it('isReservedPath covers /api and /__r4c and everything under them, in any case, and nothing else', () => {
    expect(['/api', '/api/', '/api/x', '/API/x', '/__r4c', '/__r4c/w.js'].every(isReservedPath)).toBe(true);
    expect(['/', '/apis', '/teams/api', '/__r4cx'].some(isReservedPath)).toBe(false);
    expect(['/%2Fapi', '/./__r4c/w.js', '/\\api', '/teams/%2e%2e/api/x', '/x%zz'].every(isReservedPath)).toBe(true);
    expect(['/%2Fapis', '/x/../teams', '/teams/%2Fapi'].some(isReservedPath)).toBe(false);
  });

  it('defaultWebDistDir prefers WEB_DIST_DIR, else apps/web/dist beside the API', () => {
    expect(defaultWebDistDir({ WEB_DIST_DIR: '/app/public' })).toBe('/app/public');
    expect(defaultWebDistDir({})).toMatch(/apps\/web\/dist$/);
  });
});

describe('non-HTTP contexts', () => {
  it('the interceptor passes anything but HTTP straight through', async () => {
    const context = { getType: () => 'rpc' } as unknown as ExecutionContext;
    const handler: CallHandler = { handle: () => of('value') };
    await expect(lastValueFrom(new RedInterceptor().intercept(context, handler))).resolves.toBe('value');
  });

  it('the filter records nothing outside HTTP', () => {
    const filter = new FinalStatusFilter();
    const superCatch = vi.spyOn(Object.getPrototypeOf(FinalStatusFilter.prototype), 'catch').mockImplementation(() => undefined);
    const host = { getType: () => 'rpc', switchToHttp: vi.fn() } as unknown as ArgumentsHost;
    filter.catch(new Error('x'), host);
    expect(superCatch).toHaveBeenCalledOnce();
    expect(host.switchToHttp).not.toHaveBeenCalled();
    superCatch.mockRestore();
  });
});

// GWP#9: SYNTHETIC_SUBJECTS and FAULT_ADMIN_SUBJECTS are comma-separated OIDC subjects.
describe('subjectsFromEnv', () => {
  it('parses a comma-separated list, trimmed, with empty entries dropped', () => {
    expect([...subjectsFromEnv('SYNTHETIC_SUBJECTS', { SYNTHETIC_SUBJECTS: ' k6-ci, ,a1b2-c3d4 ,,' })]).toEqual(['k6-ci', 'a1b2-c3d4']);
    expect(subjectsFromEnv('SYNTHETIC_SUBJECTS', {}).size).toBe(0);
    expect(subjectsFromEnv('FAULT_ADMIN_SUBJECTS', { FAULT_ADMIN_SUBJECTS: '' }).size).toBe(0);
  });

  it('refuses a subject with inner whitespace or over 255 characters, naming the variable', () => {
    expect(() => subjectsFromEnv('SYNTHETIC_SUBJECTS', { SYNTHETIC_SUBJECTS: 'k6-ci,a b' })).toThrow(/^SYNTHETIC_SUBJECTS /);
    expect(() => subjectsFromEnv('FAULT_ADMIN_SUBJECTS', { FAULT_ADMIN_SUBJECTS: 'x'.repeat(256) })).toThrow(/^FAULT_ADMIN_SUBJECTS /);
    expect([...subjectsFromEnv('FAULT_ADMIN_SUBJECTS', { FAULT_ADMIN_SUBJECTS: 'x'.repeat(255) })]).toEqual(['x'.repeat(255)]);
  });
});

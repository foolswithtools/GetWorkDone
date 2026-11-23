import { describe, expect, it, vi } from 'vitest';
import { startProfiling } from './profiling.js';

const opts = { serviceName: 'getworkdone-api', serviceVersion: 'abc1234', deploymentEnvironment: 'getworkdone-dev', instanceName: 'getworkdone-dev' };

function fakePyroscope() {
  return { init: vi.fn(), start: vi.fn() };
}

describe('profiling', () => {
  it('is off unless PYROSCOPE_ENABLED=true, and then never loads the native profiler', async () => {
    const load = vi.fn(async () => fakePyroscope());
    await expect(startProfiling(opts, { env: {}, load })).resolves.toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('stays off with OTEL_SDK_DISABLED=true', async () => {
    const load = vi.fn(async () => fakePyroscope());
    await expect(startProfiling(opts, { env: { PYROSCOPE_ENABLED: 'true', OTEL_SDK_DISABLED: 'true' }, load })).resolves.toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('pushes to the Alloy sidecar on :4040 tagged with the version, environment and instance', async () => {
    const pyroscope = fakePyroscope();
    await expect(startProfiling(opts, { env: { PYROSCOPE_ENABLED: 'true' }, load: async () => ({ default: pyroscope }) })).resolves.toBe(true);
    expect(pyroscope.init).toHaveBeenCalledWith({
      serverAddress: 'http://localhost:4040',
      appName: 'getworkdone-api',
      tags: { service_version: 'abc1234', deployment_environment: 'getworkdone-dev', instance: 'getworkdone-dev' },
    });
    expect(pyroscope.start).toHaveBeenCalledOnce();
  });

  it('honours PYROSCOPE_SERVER_ADDRESS', async () => {
    const pyroscope = fakePyroscope();
    await startProfiling(opts, { env: { PYROSCOPE_ENABLED: 'true', PYROSCOPE_SERVER_ADDRESS: 'http://alloy:4040' }, load: async () => pyroscope });
    expect(pyroscope.init.mock.calls[0]?.[0]).toMatchObject({ serverAddress: 'http://alloy:4040' });
  });
});

// Continuous profiling, ported from the exemplar-shop (packages/telemetry/src/profiling.ts @ 12a071e):
// gated on PYROSCOPE_ENABLED=true (:26), then @pyroscope/nodejs pushes to the Alloy sidecar's
// pyroscope.receive_http on :4040 (:49; D-027). @datadog/pprof underneath is a native addon, built for
// the image's platform (pnpm-workspace.yaml onlyBuiltDependencies, Dockerfile).
//
// Differences from the exemplar: the tags carry the version, environment and instance from the same
// options as setupOtel (the exemplar's were empty), and OTEL_SDK_DISABLED=true also turns it off.

import type { OtelOptions } from './otel.js';

interface Pyroscope {
  init(config: { serverAddress: string; appName: string; tags: Record<string, string> }): void;
  start(): void;
}

export interface ProfilingOptions {
  env?: NodeJS.ProcessEnv;
  /** Loads @pyroscope/nodejs; replaced in tests so the native addon is never needed there. */
  load?: () => Promise<Pyroscope | { default: Pyroscope }>;
}

const DEFAULT_SERVER_ADDRESS = 'http://localhost:4040';

/** Start profiling when enabled; resolves to whether it started. */
export async function startProfiling(opts: OtelOptions, { env = process.env, load }: ProfilingOptions = {}): Promise<boolean> {
  if (env.PYROSCOPE_ENABLED !== 'true') return false;
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true') return false;
  const loaded = await (load ?? (() => import('@pyroscope/nodejs') as Promise<Pyroscope | { default: Pyroscope }>))();
  const pyroscope = 'default' in loaded ? loaded.default : loaded;
  pyroscope.init({
    serverAddress: env.PYROSCOPE_SERVER_ADDRESS || DEFAULT_SERVER_ADDRESS,
    appName: opts.serviceName,
    tags: {
      service_version: opts.serviceVersion,
      deployment_environment: opts.deploymentEnvironment,
      instance: opts.instanceName,
    },
  });
  pyroscope.start();
  return true;
}

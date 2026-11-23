import 'reflect-metadata';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { INestApplication, LoggerService } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { httpServerSpans } from '@getworkdone/telemetry';
import { AppModule, type AppModuleOptions } from './app.module.js';
import { NestPinoLogger } from './common/logger.js';
import { isSynthetic, markRequestStart, markSyntheticSubjects } from './common/red.js';
import { securityHeaders } from './common/security-headers.js';
import { subjectsFromEnv } from './common/subjects.js';
import { faultOptionsFromEnv } from './modules/fault/fault.module.js';
import { r4cOptionsFromEnv } from './modules/r4c/signing-key.js';

/** apps/web/dist, beside this package in the repo; the image sets WEB_DIST_DIR. */
export function defaultWebDistDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.WEB_DIST_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
}

/**
 * How many proxies in front of the API to trust for the client address (Express `trust proxy`), from
 * TRUST_PROXY_HOPS: 0 by default (req.ip is the socket peer), 1 behind the ALB, which appends the
 * address it saw to X-Forwarded-For. Anything but a whole number stops startup. GWP#16.
 */
export function trustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.TRUST_PROXY_HOPS;
  if (!value) return 0;
  if (!/^\d+$/.test(value)) throw new Error(`TRUST_PROXY_HOPS must be a whole number of proxies, not "${value}"`);
  return Number(value);
}

export interface CreateAppOptions extends Partial<AppModuleOptions> {
  logger?: LoggerService | false;
  /** Proxies to trust for the client address; TRUST_PROXY_HOPS when absent. */
  trustProxyHops?: number;
  /** Subjects whose traffic the RED metrics label synthetic="true"; SYNTHETIC_SUBJECTS when absent (GWP#9). */
  syntheticSubjects?: ReadonlySet<string>;
}

/** The Nest app as main.ts runs it, not yet listening. */
export async function createApp({
  webDistDir = defaultWebDistDir(), extraModules, distribute, quotas, logger = new NestPinoLogger(), trustProxyHops: hops = trustProxyHops(),
  syntheticSubjects = subjectsFromEnv('SYNTHETIC_SUBJECTS'), fault = faultOptionsFromEnv(), r4c = r4cOptionsFromEnv(),
}: CreateAppOptions = {}): Promise<INestApplication> {
  // abortOnError off: a provider that refuses to start (the fake identity provider outside tests) throws
  // here rather than Nest calling process.exit, so main.ts exits non-zero and tests can see the error.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot({ webDistDir, fault, r4c, ...(extraModules ? { extraModules } : {}), ...(distribute ? { distribute } : {}), ...(quotas ? { quotas } : {}) }), { logger, abortOnError: false });
  // req.ip, which the sign-in rate limit counts by, is the client the trusted proxies saw.
  if (hops > 0) app.set('trust proxy', hops);
  // First, before any route: the request span continues the browser's traceparent, and the RED
  // duration starts, so requests that fail before a handler (no route, bad body) are timed too. At the
  // end, a probe's span gets gwd.synthetic = true for the sidecar's tail sampler (GWP#58).
  app.use(httpServerSpans({ synthetic: (req) => isSynthetic(req as Parameters<typeof isSynthetic>[0]) }));
  app.use((req: Parameters<typeof markRequestStart>[0], _res: unknown, next: () => void) => {
    markRequestStart(req);
    markSyntheticSubjects(req, syntheticSubjects);
    next();
  });
  // Before the built files and the routes, so every response carries the security headers: the JS and
  // CSS files, the SPA, the API and the guards' refusals (docs/security.md, GWP#48).
  app.use(securityHeaders());
  // Built files (the hashed JS and CSS bundles) are served as is; anything else falls through to the
  // routes, and the SPA fallback (spa/spa.controller.ts) comes last. No directory redirect: its 301
  // would replace the CSP with serve-static's own, and /assets falls through like /assets/ does.
  app.useStaticAssets(webDistDir, { index: false, fallthrough: true, redirect: false });
  // Express's default, set here on purpose: it bounds the work one request can ask for, such as the
  // fields and values capture validates (docs/capture.md).
  app.useBodyParser('json', { limit: '100kb' });
  return app;
}

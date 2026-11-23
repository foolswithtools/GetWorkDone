import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { mockIssuer, type MockIssuer, type MockUser } from '../../../apps/api/test/support/mock-issuer.js';

// The built API (apps/api/dist) for an e2e spec: the real OIDC provider against a local mock issuer, in
// production mode, against the Postgres at DATABASE_URL: the run's scratch database, which
// global-setup.ts creates and migrates, never the integration partition's (GWP#26). Shared by
// sign-in.spec.ts (GWP#3), builder-capture.spec.ts (GWP#4) and the later specs.

const root = fileURLToPath(new URL('../../../', import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

export interface ApiServer {
  baseURL: string;
  issuer: MockIssuer;
  /** Everything the API wrote to stdout and stderr so far. */
  output(): string;
  stop(): Promise<void>;
}

/**
 * Start the issuer and the API; resolves once /healthz answers 200. `user` is who /authorize signs in
 * first; `extraEnv` adds to the API's environment (r4c.spec.ts sets R4C_SIGNING_KEY, GWP#10).
 */
export async function startApiServer(user: MockUser, extraEnv: NodeJS.ProcessEnv = {}): Promise<ApiServer> {
  const issuer = await mockIssuer({ user });
  const port = await freePort();
  // localhost, not 127.0.0.1: the cookies are Secure, and browsers treat http://localhost as secure.
  const baseURL = `http://localhost:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    HOST: '127.0.0.1',
    OTEL_SDK_DISABLED: 'true',
    LOG_LEVEL: 'debug',
    IDENTITY_PROVIDER: 'oidc',
    OIDC_ISSUER_URL: issuer.issuer,
    OIDC_CLIENT_ID: issuer.clientId,
    OIDC_CLIENT_SECRET: issuer.clientSecret,
    OIDC_REDIRECT_URI: `${baseURL}/auth/callback`,
    // Production mode enforces the quotas (GWP#50); the paging journey captures 101 items with one
    // subject inside a minute (builder-capture.spec.ts), past the default 60.
    QUOTA_ITEMS_PER_SUBJECT_PER_MINUTE: '1000',
    // Every spec signs in from 127.0.0.1 against the run's one database, and /auth/login's limit is
    // counted there across API processes, so the whole suite shares the default 20 a minute; a fast
    // runner went over it at sign-in.spec.ts (GWP#133). The limit's own behaviour is covered by
    // apps/api/test/auth.integration.test.ts.
    LOGIN_RATE_LIMIT: '1000',
    ...extraEnv,
  };
  let output = '';
  const api: ChildProcess = spawn(process.execPath, ['apps/api/dist/main.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  api.stderr?.on('data', (d: Buffer) => (output += d.toString()));
  await expect.poll(async () => (await fetch(`${baseURL}/healthz`).catch(() => undefined))?.status, { timeout: 20_000, message: output }).toBe(200);
  return {
    baseURL,
    issuer,
    output: () => output,
    stop: async () => {
      if (api.exitCode === null) api.kill('SIGKILL');
      await issuer.close();
    },
  };
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { envNamesReadByCode } from './env-names.ts';

// compose.yaml: GetWorkDone on one machine with `docker compose up --build` (Postgres, the migrate
// one-off, the API image, Dex as a local OIDC issuer and Mailpit for email outputs). Published with the
// app (publish/allowlist.txt), so it reads only published files. What it guards is what breaks a local
// run silently: an image pinned by tag, the migrate command drifting from the Dockerfile's, the issuer
// failing the API's loopback rule (apps/api/src/modules/identity/oidc.provider.ts), Dex and the API
// disagreeing on the client, and a variable the code no longer reads.
const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');

interface Service {
  image?: string;
  build?: unknown;
  command?: string[] | string;
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition?: string }>;
  network_mode?: string;
  ports?: string[];
  volumes?: string[];
  profiles?: string[];
}
const compose = () => parse(read('compose.yaml')) as { services: Record<string, Service> };
const dex = () =>
  parse(read('deploy/local/dex.yaml')) as {
    issuer: string;
    staticClients: { id: string; secret: string; redirectURIs: string[] }[];
    staticPasswords: { email: string; hash: string }[];
  };

/** `${NAME:-default}` as its default; any other value as it is. */
const resolved = (value: string | undefined) => value?.replace(/\$\{[A-Z0-9_]+:-([^}]*)\}/g, '$1');

describe('compose.yaml', () => {
  it('pins every pulled image by digest', () => {
    const pulled = Object.entries(compose().services).filter(([, s]) => s.image && !s.build);
    expect(pulled.length).toBeGreaterThan(0);
    for (const [name, s] of pulled) expect(s.image, name).toMatch(/^[a-z0-9./-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
  });

  it('runs Postgres 16, the major CI and the sandbox run (renovate.json)', () => {
    expect(compose().services.postgres?.image).toMatch(/^postgres:16-alpine@/);
  });

  it('builds the API and migrate services from the Dockerfile and migrates with its documented command', () => {
    const { api, migrate } = compose().services;
    expect(api?.build).toBe('.');
    expect(migrate?.build).toBe('.');
    const documented = read('Dockerfile').match(/^#\s+(node node_modules\/@getworkdone\/db\/dist\/migrate-task\.js)$/m)?.[1];
    expect(documented).toBeDefined();
    expect(migrate?.command).toEqual(documented?.split(' '));
  });

  it('starts the API only after the migrations, and those only once Postgres is healthy', () => {
    const { api, migrate } = compose().services;
    expect(migrate?.depends_on?.postgres?.condition).toBe('service_healthy');
    expect(api?.depends_on?.migrate?.condition).toBe('service_completed_successfully');
    expect(api?.depends_on?.dex).toBeUndefined(); // the API runs without the bundled issuer
  });

  it('migrates as the database owner and runs the API as the least-privilege app role', () => {
    const { api, migrate } = compose().services;
    const app = JSON.parse(migrate?.environment?.DATABASE_APP_CREDENTIALS ?? '{}') as { username?: string; password?: string };
    expect(app.username).toBe('getworkdone_app'); // packages/db/src/app-role.ts APP_ROLE_NAME
    const apiUrl = new URL(api?.environment?.DATABASE_URL ?? '');
    expect(apiUrl.username).toBe('getworkdone_app');
    expect(decodeURIComponent(apiUrl.password)).toBe(app.password);
    expect(new URL(migrate?.environment?.DATABASE_URL ?? '').username).not.toBe('getworkdone_app');
  });

  it("puts Dex in the API's network namespace, so one loopback issuer URL works for the browser and the API", () => {
    const { api, dex: idp } = compose().services;
    expect(idp?.network_mode).toBe('service:api');
    expect(api?.ports).toEqual(expect.arrayContaining([expect.stringMatching(/:8080$/), expect.stringMatching(/:5556$/)]));
    const issuer = new URL(resolved(api?.environment?.OIDC_ISSUER_URL) ?? '');
    expect(['localhost', '127.0.0.1']).toContain(issuer.hostname);
    expect(issuer.port).toBe('5556');
  });

  it('agrees with deploy/local/dex.yaml on the issuer, the client and the redirect URI', () => {
    const env = compose().services.api?.environment ?? {};
    const config = dex();
    expect(config.issuer).toBe(resolved(env.OIDC_ISSUER_URL));
    const client = config.staticClients.find((c) => c.id === resolved(env.OIDC_CLIENT_ID));
    expect(client?.secret).toBe(resolved(env.OIDC_CLIENT_SECRET));
    expect(client?.redirectURIs).toContain(resolved(env.OIDC_REDIRECT_URI));
    expect(new URL(resolved(env.OIDC_REDIRECT_URI) ?? '').pathname).toBe('/auth/callback');
  });

  it("lets an installer's own issuer replace Dex through OIDC_* in the environment", () => {
    const env = compose().services.api?.environment ?? {};
    for (const name of ['OIDC_ISSUER_URL', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI']) {
      expect(env[name], name).toMatch(new RegExp(`^\\$\\{${name}:-[^}]+\\}$`));
    }
  });

  it('signs in a demo user with an example.com address and a bcrypt hash, never a plaintext password', () => {
    const users = dex().staticPasswords;
    expect(users.length).toBeGreaterThan(0);
    for (const user of users) {
      expect(user.email).toMatch(/@example\.com$/);
      expect(user.hash).toMatch(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);
    }
  });

  it('sends email outputs to Mailpit over SMTP', () => {
    const { api, mailpit } = compose().services;
    expect(mailpit?.image).toMatch(/^axllent\/mailpit:/);
    expect(api?.environment?.EMAIL_TRANSPORT).toBe('smtp');
    expect(new URL(api?.environment?.SMTP_URL ?? '').host).toBe('mailpit:1025');
  });

  it('sets only variables the code reads', () => {
    const read = envNamesReadByCode();
    const names = Object.values(compose().services).flatMap((s) => (s.image?.startsWith('postgres:') || s.image?.includes('mailpit') ? [] : Object.keys(s.environment ?? {})));
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(read.has(name), name).toBe(true);
  });
});

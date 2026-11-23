// The one database URL the API's pg adapter and the Prisma CLI read (#8). Local runs and CI set
// DATABASE_URL. The sandbox task sets DATABASE_HOST, DATABASE_PORT and DATABASE_NAME from the data
// stage's contract, DATABASE_CREDENTIALS to a secret whose JSON holds `username` and `password` (the API's
// getworkdone/<instance>/db-app, the migrate task's RDS master secret, #57) and DATABASE_SSL_ROOT_CERT
// to the image's RDS CA bundle, /app/rds-ca.pem, and DATABASE_PRISMA_SSL_CERT to the instance's one root,
// /app/rds-ca-prisma.pem (docs/deploy/sandbox.md). Node built-ins only: prisma.config.ts loads this file as source,
// inside the image too, where no other package is resolvable from it.

/** Matches the local Postgres in README.md and the CI service container. */
export const DEFAULT_DATABASE_URL = 'postgresql://getworkdone:getworkdone@localhost:5432/getworkdone';

export interface DatabaseUrlOptions {
  /**
   * Who connects, which decides the TLS parameters. RDS forces TLS (rds.force_ssl) and its certificates
   * do not chain to Node's bundled roots, so verification needs the CA bundle at DATABASE_SSL_ROOT_CERT
   * (#57). `pg` (the API's PrismaPg adapter, and rereadingPool) gets sslmode=verify-full with
   * uselibpqcompat=true and sslrootcert, so pg-connection-string@2.14.1 reads the file into ssl.ca and
   * checks the chain and the host name (index.js:98-100, :134-136). `prisma` (the CLI's schema engine)
   * gets sslmode=require with sslcert, the CA, and sslaccept=strict; without strict it accepts any
   * certificate. Prisma's engine (7.10.1) trusts only the first certificate in that file, so a bundle
   * fails against any server but the first block's: DATABASE_PRISMA_SSL_CERT names a file with the one
   * root the instance chains to, and falls back to DATABASE_SSL_ROOT_CERT. Without either, both encrypt
   * without verifying, as #8 shipped: uselibpqcompat=true makes pg's require mean that (index.js:116-121).
   */
  consumer: 'pg' | 'prisma';
}

const PARTS = ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_CREDENTIALS'] as const;

function tls(consumer: DatabaseUrlOptions['consumer'], env: NodeJS.ProcessEnv): string {
  const rootCert = consumer === 'pg' ? env.DATABASE_SSL_ROOT_CERT : env.DATABASE_PRISMA_SSL_CERT || env.DATABASE_SSL_ROOT_CERT;
  if (!rootCert) return consumer === 'pg' ? 'sslmode=require&uselibpqcompat=true' : 'sslmode=require';
  // Both parsers decode the query; the slashes stay readable.
  const path = encodeURIComponent(rootCert).replaceAll('%2F', '/');
  return consumer === 'pg' ? `sslmode=verify-full&uselibpqcompat=true&sslrootcert=${path}` : `sslmode=require&sslcert=${path}&sslaccept=strict`;
}

/**
 * DATABASE_URL when set; otherwise the URL built from the parts and the credentials' JSON, both
 * percent-encoded, with the consumer's TLS parameters. With neither DATABASE_URL nor any part set it is
 * the local Postgres; with some parts set, a missing or malformed one throws, naming the variable and
 * never the credentials.
 */
export function databaseUrlFromEnv(env: NodeJS.ProcessEnv, { consumer }: DatabaseUrlOptions): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  if (PARTS.every((name) => !env[name])) return DEFAULT_DATABASE_URL;

  for (const name of PARTS) {
    if (!env[name]) throw new Error(`${name} is not set: the database URL needs DATABASE_URL, or all of ${PARTS.join(', ')}`);
  }
  const host = env.DATABASE_HOST as string;
  const port = env.DATABASE_PORT as string;
  const name = env.DATABASE_NAME as string;
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) {
    throw new Error('DATABASE_PORT must be a whole number from 1 to 65535');
  }
  const { username, password } = databaseCredentials(env.DATABASE_CREDENTIALS as string);
  const auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
  return `postgresql://${auth}@${host}:${port}/${encodeURIComponent(name)}?${tls(consumer, env)}`;
}

/**
 * A database secret's JSON as its username and password; a malformed one throws, naming `variable` and
 * never quoting it.
 */
export function databaseCredentials(json: string, variable = 'DATABASE_CREDENTIALS'): { username: string; password: string } {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    // The parser's message can quote the input, so it is dropped, not chained as the cause.
    throw new Error(`${variable} is not valid JSON: it must be a database secret, {"username": ..., "password": ...}`);
  }
  const { username, password } = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  if (typeof username !== 'string' || username === '' || typeof password !== 'string' || password === '') {
    throw new Error(`${variable} must be a JSON object with non-empty string "username" and "password" keys`);
  }
  return { username, password };
}

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'pg-connection-string';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DATABASE_URL, databaseUrlFromEnv } from './database-url.js';

// #8: the sandbox task gets the database as parts plus RDS's master secret (DATABASE_CREDENTIALS, the
// secret's JSON), never as one DATABASE_URL. Local runs and CI keep setting DATABASE_URL.
const password = 'p@ss/w%rd:with?#&=chars';
const parts = {
  DATABASE_HOST: 'getworkdone-dev.abc.us-east-1.rds.example.com',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'getworkdone',
  DATABASE_CREDENTIALS: JSON.stringify({ username: 'getworkdone_admin', password, engine: 'postgres' }),
};

function failure(env: NodeJS.ProcessEnv): Error {
  try {
    databaseUrlFromEnv(env, { consumer: 'pg' });
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected databaseUrlFromEnv to throw');
}

describe('databaseUrlFromEnv', () => {
  it('returns DATABASE_URL unchanged when it is set, for either consumer', () => {
    const url = 'postgresql://a:b@db:5432/x';
    expect(databaseUrlFromEnv({ ...parts, DATABASE_URL: url }, { consumer: 'pg' })).toBe(url);
    expect(databaseUrlFromEnv({ DATABASE_URL: url }, { consumer: 'prisma' })).toBe(url);
  });

  it('falls back to the local and CI Postgres when neither DATABASE_URL nor any part is set', () => {
    expect(databaseUrlFromEnv({}, { consumer: 'pg' })).toBe(DEFAULT_DATABASE_URL);
    expect(databaseUrlFromEnv({ DATABASE_URL: '' }, { consumer: 'prisma' })).toBe(DEFAULT_DATABASE_URL);
  });

  it('builds the URL from the parts, percent-encoding the user name and the password', () => {
    const url = databaseUrlFromEnv(parts, { consumer: 'prisma' });
    expect(url).toBe(
      `postgresql://getworkdone_admin:${encodeURIComponent(password)}@getworkdone-dev.abc.us-east-1.rds.example.com:5432/getworkdone?sslmode=require`,
    );
    expect(url).toContain('p%40ss%2Fw%25rd%3Awith%3F%23%26%3Dchars');
    const parsed = new URL(url);
    expect(decodeURIComponent(parsed.username)).toBe('getworkdone_admin');
    expect(decodeURIComponent(parsed.password)).toBe(password);
  });

  it('percent-encodes a user name with reserved characters too', () => {
    const env = { ...parts, DATABASE_CREDENTIALS: JSON.stringify({ username: 'a@b:c/d', password: 'x' }) };
    expect(databaseUrlFromEnv(env, { consumer: 'prisma' })).toMatch(/^postgresql:\/\/a%40b%3Ac%2Fd:x@/);
  });

  it('gives the pg adapter sslmode=require&uselibpqcompat=true and the Prisma CLI sslmode=require only', () => {
    expect(databaseUrlFromEnv(parts, { consumer: 'pg' })).toMatch(/\/getworkdone\?sslmode=require&uselibpqcompat=true$/);
    expect(databaseUrlFromEnv(parts, { consumer: 'prisma' })).toMatch(/\/getworkdone\?sslmode=require$/);
  });

  // RDS's certificates do not chain to Node's bundled roots: without uselibpqcompat, pg-connection-string
  // keeps verification on for sslmode=require and the first query fails. With it, require means encrypt
  // without verification (pg-connection-string@2.14.1 index.js:116-121, :139-151).
  it('makes pg encrypt without verifying the chain, so the first query does not fail on RDS', () => {
    const config = parse(databaseUrlFromEnv(parts, { consumer: 'pg' }));
    expect(config.ssl).toEqual(expect.objectContaining({ rejectUnauthorized: false }));
    expect(config.user).toBe('getworkdone_admin');
    expect(config.password).toBe(password);
    expect(config.host).toBe(parts.DATABASE_HOST);
    expect(config.port).toBe('5432');
    expect(config.database).toBe('getworkdone');
  });

  it.each(['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_CREDENTIALS'] as const)('names %s when it is missing', (name) => {
    const env: NodeJS.ProcessEnv = { ...parts };
    delete env[name];
    expect(failure(env).message).toMatch(new RegExp(`^${name} is not set`));
    expect(failure({ ...parts, [name]: '' }).message).toMatch(new RegExp(`^${name} is not set`));
  });

  it('refuses a port that is not a whole number from 1 to 65535', () => {
    for (const port of ['x', '0', '65536', '54.3', '5432 ']) {
      expect(failure({ ...parts, DATABASE_PORT: port }).message).toMatch(/^DATABASE_PORT must be/);
    }
  });

  it.each([
    ['unparsable JSON', `{"username":"getworkdone_admin","password":"${password}"`],
    ['JSON that is not an object', JSON.stringify([password])],
    ['JSON without username', JSON.stringify({ password })],
    ['JSON without password', JSON.stringify({ username: 'getworkdone_admin' })],
    ['an empty password', JSON.stringify({ username: 'getworkdone_admin', password: '' })],
    ['a password that is not a string', JSON.stringify({ username: 'getworkdone_admin', password: 1234 })],
  ])('names DATABASE_CREDENTIALS for %s and never echoes the credentials', (_case, credentials) => {
    const error = failure({ ...parts, DATABASE_CREDENTIALS: credentials });
    expect(error.message).toMatch(/^DATABASE_CREDENTIALS /);
    expect(error.message).not.toContain(password);
    expect(error.message).not.toContain('1234');
    expect(error.message).not.toContain('getworkdone_admin');
    expect(error.cause).toBeUndefined();
  });

  // #57: with DATABASE_SSL_ROOT_CERT (the image's /app/rds-ca.pem, the committed RDS CA bundle) both
  // consumers verify the server's chain and host name. Unset, the URLs are #8's.
  describe('with DATABASE_SSL_ROOT_CERT', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
    const dir = mkdtempSync(join(tmpdir(), 'gwp57-'));
    const caPath = join(dir, 'rds-ca.pem');
    writeFileSync(caPath, ca);
    const verified = { ...parts, DATABASE_SSL_ROOT_CERT: '/app/rds-ca.pem' };

    it('gives the pg adapter sslmode=verify-full&uselibpqcompat=true&sslrootcert=<path>', () => {
      expect(databaseUrlFromEnv(verified, { consumer: 'pg' })).toMatch(/\/getworkdone\?sslmode=verify-full&uselibpqcompat=true&sslrootcert=\/app\/rds-ca\.pem$/);
    });

    it('gives the Prisma CLI sslmode=require&sslcert=<path>&sslaccept=strict', () => {
      expect(databaseUrlFromEnv(verified, { consumer: 'prisma' })).toMatch(/\/getworkdone\?sslmode=require&sslcert=\/app\/rds-ca\.pem&sslaccept=strict$/);
    });

    it('makes pg verify against the file: ssl.ca is its contents and rejectUnauthorized is not false', () => {
      const config = parse(databaseUrlFromEnv({ ...parts, DATABASE_SSL_ROOT_CERT: caPath }, { consumer: 'pg' }));
      expect(config.ssl).toEqual(expect.objectContaining({ ca }));
      expect((config.ssl as { rejectUnauthorized?: boolean }).rejectUnauthorized).not.toBe(false);
      expect((config.ssl as { checkServerIdentity?: unknown }).checkServerIdentity).toBeUndefined();
    });

    it('percent-encodes a path with query characters, keeping its slashes', () => {
      const env = { ...parts, DATABASE_SSL_ROOT_CERT: '/a b/c&d=e#f.pem' };
      expect(databaseUrlFromEnv(env, { consumer: 'pg' })).toMatch(/sslrootcert=\/a%20b\/c%26d%3De%23f\.pem$/);
      expect(new URL(databaseUrlFromEnv(env, { consumer: 'prisma' })).searchParams.get('sslcert')).toBe('/a b/c&d=e#f.pem');
    });

    // Prisma's engine trusts only the first certificate in its sslcert file (seen with 7.10.1 against a
    // TLS Postgres, #57's review), so the migrate task gives it the instance's one root.
    it('gives the Prisma CLI DATABASE_PRISMA_SSL_CERT when set, and pg still DATABASE_SSL_ROOT_CERT', () => {
      const env = { ...verified, DATABASE_PRISMA_SSL_CERT: '/app/rds-ca-prisma.pem' };
      expect(databaseUrlFromEnv(env, { consumer: 'prisma' })).toMatch(/\?sslmode=require&sslcert=\/app\/rds-ca-prisma\.pem&sslaccept=strict$/);
      expect(databaseUrlFromEnv(env, { consumer: 'pg' })).toMatch(/sslrootcert=\/app\/rds-ca\.pem$/);
      expect(databaseUrlFromEnv({ ...parts, DATABASE_PRISMA_SSL_CERT: '/p.pem' }, { consumer: 'prisma' })).toMatch(/sslcert=\/p\.pem&sslaccept=strict$/);
      expect(databaseUrlFromEnv({ ...parts, DATABASE_PRISMA_SSL_CERT: '/p.pem' }, { consumer: 'pg' })).toMatch(/\?sslmode=require&uselibpqcompat=true$/);
    });

    it('keeps #8\'s URLs when it is unset or empty', () => {
      for (const env of [parts, { ...parts, DATABASE_SSL_ROOT_CERT: '' }]) {
        expect(databaseUrlFromEnv(env, { consumer: 'pg' })).toMatch(/\?sslmode=require&uselibpqcompat=true$/);
        expect(databaseUrlFromEnv(env, { consumer: 'prisma' })).toMatch(/\?sslmode=require$/);
      }
    });

    it('leaves DATABASE_URL unchanged for both consumers', () => {
      const url = 'postgresql://a:b@db:5432/x';
      expect(databaseUrlFromEnv({ ...verified, DATABASE_URL: url }, { consumer: 'pg' })).toBe(url);
      expect(databaseUrlFromEnv({ ...verified, DATABASE_URL: url }, { consumer: 'prisma' })).toBe(url);
    });
  });
});

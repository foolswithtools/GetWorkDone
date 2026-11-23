import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { RereadingPool, rereadingPool, type CredentialRereadOptions } from './credentials.js';
import { databaseUrlFromEnv } from './database-url.js';

// #66: RDS rotates the master secret; a task that started before the rotation holds the old password.
// The fake server below accepts one password at a time and fails any other with SQLSTATE 28P01, as
// Postgres does; pg-pool builds its clients from options.Client, so no database is needed.
const server = { password: 'old', connects: 0 };

class FakeClient extends EventEmitter {
  constructor(private readonly options: pg.ClientConfig) {
    super();
  }

  connect(callback: (error?: Error) => void): void {
    server.connects += 1;
    const { password } = this.options;
    void Promise.resolve(typeof password === 'function' ? password() : password).then((value) => {
      if (value === server.password) return callback();
      callback(Object.assign(new Error('password authentication failed for user "getworkdone"'), { code: '28P01' }));
    });
  }

  end(callback?: () => void): void {
    callback?.();
  }
}

const secret = (password: string): string => JSON.stringify({ username: 'getworkdone', password });

function pool(options: Partial<CredentialRereadOptions> = {}): { pool: RereadingPool; reads: () => number } {
  let reads = 0;
  const created = new RereadingPool(
    { host: 'db', user: 'getworkdone', database: 'getworkdone', password: 'old', Client: FakeClient as unknown as typeof pg.Client },
    {
      readSecret: async () => {
        reads += 1;
        return secret(server.password);
      },
      ...options,
    },
  );
  pools.push(created);
  return { pool: created, reads: () => reads };
}

const pools: RereadingPool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
  server.password = 'old';
  server.connects = 0;
});

describe('RereadingPool (#66)', () => {
  it('connects with the password it was given and reads no secret while it works', async () => {
    const { pool: p, reads } = pool();
    const client = await p.connect();
    client.release();
    expect(reads()).toBe(0);
  });

  it('re-reads the secret once when the first connection fails with 28P01, then connects', async () => {
    const { pool: p, reads } = pool();
    server.password = 'rotated';

    const client = await p.connect();
    client.release();

    expect(reads()).toBe(1);
    expect(server.connects).toBe(2);
  });

  it('keeps the re-read password for later connections', async () => {
    const { pool: p, reads } = pool();
    server.password = 'rotated';
    const first = await p.connect();
    const second = await p.connect();
    first.release();
    second.release();
    expect(reads()).toBe(1);
    expect(server.connects).toBe(3);
  });

  it('re-reads once for connections that fail together after a rotation', async () => {
    const { pool: p, reads } = pool();
    server.password = 'rotated';
    const clients = await Promise.all([1, 2, 3, 4, 5].map(() => p.connect()));
    clients.forEach((c) => c.release());
    expect(reads()).toBe(1);
  });

  it('answers the callback form pg-pool uses for pool.query', async () => {
    const { pool: p, reads } = pool();
    server.password = 'rotated';
    await new Promise<void>((resolve, reject) => {
      p.connect((error, client) => {
        if (error || !client) return reject(error ?? new Error('no client'));
        client.release();
        resolve();
      });
    });
    expect(reads()).toBe(1);
  });

  it('hands the callback form the error when the connection still fails', async () => {
    const { pool: p } = pool({ readSecret: async () => secret('still-wrong') });
    server.password = 'rotated';
    const error = await new Promise<Error | undefined>((resolve) => p.connect((e) => resolve(e)));
    expect(error).toMatchObject({ code: '28P01' });
  });

  it('fails with 28P01 after one re-read when the new password is refused too, without looping', async () => {
    let reads = 0;
    const { pool: p } = pool({ readSecret: async () => ((reads += 1), secret('still-wrong')) });
    server.password = 'rotated';
    await expect(p.connect()).rejects.toMatchObject({ code: '28P01' });
    expect(reads).toBe(1);
    expect(server.connects).toBe(2);
  });

  it('reads no secret for a failure other than 28P01', async () => {
    let reads = 0;
    const refused = class extends FakeClient {
      override connect(callback: (error?: Error) => void): void {
        callback(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      }
    };
    const p = new RereadingPool(
      { host: 'db', password: 'old', Client: refused as unknown as typeof pg.Client },
      { readSecret: async () => ((reads += 1), secret('x')) },
    );
    pools.push(p);
    await expect(p.connect()).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(reads).toBe(0);
  });

  it('fails the connection with the read error when the secret cannot be read', async () => {
    const { pool: p } = pool({ readSecret: async () => Promise.reject(new Error('AccessDeniedException')) });
    server.password = 'rotated';
    await expect(p.connect()).rejects.toThrow('AccessDeniedException');
  });

  it('reads again after a read that threw synchronously, instead of keeping its failure', async () => {
    let calls = 0;
    const { pool: p } = pool({
      readSecret: (() => {
        calls += 1;
        if (calls === 1) throw new Error('sync failure');
        return Promise.resolve(secret(server.password));
      }) as () => Promise<string>,
    });
    server.password = 'rotated';
    await expect(p.connect()).rejects.toThrow('sync failure');
    (await p.connect()).release();
    expect(calls).toBe(2);
  });

  it('refuses a secret that is not the master secret JSON, without quoting it', async () => {
    const { pool: p } = pool({ readSecret: async () => 'not json rotated' });
    server.password = 'rotated';
    const error = await p.connect().catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/DATABASE_CREDENTIALS/);
    expect((error as Error).message).not.toMatch(/rotated/);
  });

  it('tells onReread whether the password changed', async () => {
    const events: { changed: boolean }[] = [];
    const { pool: p } = pool({ onReread: (event) => events.push(event) });
    server.password = 'rotated';
    (await p.connect()).release();
    expect(events).toEqual([{ changed: true }]);
  });

  it('builds its pool from the database URL, keeping its TLS parameters and taking the password from it', async () => {
    const p = rereadingPool('postgresql://getworkdone:p%40ss@db.example:5432/getworkdone?sslmode=require&uselibpqcompat=true', {
      readSecret: async () => secret('x'),
    });
    pools.push(p);
    const options = (p as unknown as { options: pg.PoolConfig }).options;
    expect(options).toMatchObject({ host: 'db.example', port: 5432, database: 'getworkdone', user: 'getworkdone', ssl: { rejectUnauthorized: false } });
    expect(typeof options.password).toBe('function');
    expect((options.password as () => string)()).toBe('p@ss');
  });

  // #57: the verify-full URL's TLS survives parseIntoClientConfig: the CA from sslrootcert, verification on.
  it('keeps the verify-full URL\'s ssl: ca read from sslrootcert, rejectUnauthorized not false', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
    const caPath = join(mkdtempSync(join(tmpdir(), 'gwp57-')), 'rds-ca.pem');
    writeFileSync(caPath, ca);
    const url = databaseUrlFromEnv(
      {
        DATABASE_HOST: 'db.example',
        DATABASE_PORT: '5432',
        DATABASE_NAME: 'getworkdone',
        DATABASE_CREDENTIALS: secret('p@ss'),
        DATABASE_SSL_ROOT_CERT: caPath,
      },
      { consumer: 'pg' },
    );
    const p = rereadingPool(url, { readSecret: async () => secret('x') });
    pools.push(p);
    const { ssl } = (p as unknown as { options: pg.PoolConfig }).options as { ssl: { ca?: string; rejectUnauthorized?: boolean } };
    expect(ssl.ca).toBe(ca);
    expect(ssl.rejectUnauthorized).not.toBe(false);
  });
});

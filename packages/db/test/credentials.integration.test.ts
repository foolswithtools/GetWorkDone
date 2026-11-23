import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, databaseUrl, type PrismaClient } from '../src/index.js';

// #66 against a real Postgres: a throwaway login role stands in for RDS's master user, and its password
// changes mid-run as an RDS rotation changes it. The connected client's pooled session is then ended,
// as a task's sessions end over its life, so the next query opens a new connection with the old
// password, which Postgres refuses with 28P01. CI's DATABASE_URL user is the superuser that may do this.
const role = `rotation_${randomBytes(4).toString('hex')}`;
const password = (): string => randomBytes(12).toString('hex');

const admin = createPrismaClient();
let current = password();
let reads = 0;
let client: PrismaClient;
let plain: PrismaClient;

function roleUrl(secret: string): string {
  const url = new URL(databaseUrl(process.env));
  url.username = role;
  url.password = secret;
  return url.toString();
}

/** Ends the role's sessions and waits until the pools have seen their sockets close and dropped them. */
async function endRoleSessions(): Promise<void> {
  await admin.$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${role}'`);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [{ sessions }] = await admin.$queryRawUnsafe<[{ sessions: number }]>(`SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE usename = '${role}'`);
    if (sessions === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // A pooled client learns its session ended from the socket's close, a moment after the backend exits.
  await new Promise((resolve) => setTimeout(resolve, 200));
}

beforeAll(async () => {
  await admin.$executeRawUnsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${current}'`);
  const first = current;
  client = createPrismaClient(roleUrl(first), {
    readSecret: async () => {
      reads += 1;
      return JSON.stringify({ username: role, password: current });
    },
  });
  plain = createPrismaClient(roleUrl(first));
});

afterAll(async () => {
  await client.$disconnect();
  await plain.$disconnect();
  await endRoleSessions();
  await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`);
  await admin.$disconnect();
});

describe('database credentials after a rotation (#66)', () => {
  it('reconnects with the re-read password after the password changes mid-run', async () => {
    await expect(client.$queryRawUnsafe('SELECT 1 AS one')).resolves.toEqual([{ one: 1 }]);
    await expect(plain.$queryRawUnsafe('SELECT 1 AS one')).resolves.toEqual([{ one: 1 }]);
    expect(reads).toBe(0);

    current = password();
    await admin.$executeRawUnsafe(`ALTER ROLE ${role} PASSWORD '${current}'`);
    await endRoleSessions();

    // Without the re-read, the old password is refused: the failure the issue describes.
    await expect(plain.$queryRawUnsafe('SELECT 1 AS one')).rejects.toThrow();

    await expect(client.$queryRawUnsafe('SELECT 1 AS one')).resolves.toEqual([{ one: 1 }]);
    expect(reads).toBe(1);

    // A transaction takes its connection through pool.connect(), not pool.query: rotate once more.
    current = password();
    await admin.$executeRawUnsafe(`ALTER ROLE ${role} PASSWORD '${current}'`);
    await endRoleSessions();
    await expect(client.$transaction(async (tx) => tx.$queryRawUnsafe('SELECT 2 AS two'))).resolves.toEqual([{ two: 2 }]);
    expect(reads).toBe(2);
  });

  it('closes its connections on $disconnect, as the adapter does with a pool of its own', async () => {
    const url = new URL(roleUrl(current));
    url.searchParams.set('application_name', `${role}_disconnect`);
    const own = createPrismaClient(url.toString(), { readSecret: async () => JSON.stringify({ username: role, password: current }) });
    const sessions = async (): Promise<number> =>
      (await admin.$queryRawUnsafe<[{ n: number }]>(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = '${role}_disconnect'`))[0].n;

    await own.$queryRawUnsafe('SELECT 1');
    expect(await sessions()).toBe(1);

    await own.$disconnect();
    let open = 1;
    for (let attempt = 0; attempt < 50 && open > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      open = await sessions();
    }
    expect(open).toBe(0);
  });
});

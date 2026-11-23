import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_ROLE_NAME, scramSha256Verifier } from '../src/app-role.js';
import { createPrismaClient, databaseUrl } from '../src/index.js';
import { migrateTask, prismaRunner } from '../src/migrate-task.js';

// #57: the migrate task's role step (packages/db/sql/app-role.sql) on the Postgres at DATABASE_URL, run as
// the migrate task runs it (migrateTask: prisma migrate deploy, then prisma db execute --stdin), then
// checked by connecting as getworkdone_app. CI's user is a superuser that owns every table, as RDS's
// master user owns them in the sandbox.
const password = `test-'pass\\word-${randomUUID()}`;
const env = { ...process.env, DATABASE_APP_CREDENTIALS: JSON.stringify({ username: APP_ROLE_NAME, password }) };
const teamId = randomUUID();

function runRoleStep(): number {
  return migrateTask(env, prismaRunner({ stdio: 'pipe' }), () => undefined);
}

function appUrl(): string {
  const url = new URL(databaseUrl(process.env));
  url.username = APP_ROLE_NAME;
  url.password = encodeURIComponent(password);
  return url.toString();
}

async function asApp<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: appUrl() });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function sqlState(client: pg.Client, sql: string): Promise<{ code?: string; message: string }> {
  try {
    await client.query(sql);
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error(`expected ${sql} to fail`);
}

describe('app-role.sql (the API\'s database role)', () => {
  const admin = new pg.Client({ connectionString: databaseUrl(process.env) });

  beforeAll(async () => {
    await admin.connect();
    expect(runRoleStep()).toBe(0);
  }, 60_000);

  // The test's rows stay, as the triggers test's do: ItemEvent rows cannot be deleted, so neither can their team.
  afterAll(() => admin.end());

  it('lets getworkdone_app insert into Team', async () => {
    await asApp(async (client) => {
      const result = await client.query('INSERT INTO "Team" (id, name) VALUES ($1, $2) RETURNING id', [teamId, 'app role test']);
      expect(result.rows).toEqual([{ id: teamId }]);
    });
  });

  it('refuses CREATE TABLE with 42501 (permission denied for schema public)', async () => {
    await asApp(async (client) => {
      const error = await sqlState(client, 'CREATE TABLE x (id int)');
      expect(error.code).toBe('42501');
      expect(error.message).toBe('permission denied for schema public');
    });
  });

  it('refuses DROP TABLE "ItemEvent" with 42501', async () => {
    await asApp(async (client) => expect((await sqlState(client, 'DROP TABLE "ItemEvent"')).code).toBe('42501'));
  });

  it('refuses TRUNCATE and disabling the append-only trigger with 42501', async () => {
    await asApp(async (client) => {
      expect((await sqlState(client, 'TRUNCATE "Team"')).code).toBe('42501');
      expect((await sqlState(client, 'ALTER TABLE "ItemEvent" DISABLE TRIGGER USER')).code).toBe('42501');
    });
  });

  it('serves the API\'s Prisma client, and DELETE FROM "ItemEvent" still hits the append-only trigger', async () => {
    const db = createPrismaClient(appUrl());
    try {
      const team = await db.team.create({ data: { name: 'app role events' } });
      const workType = await db.workType.create({ data: { teamId: team.id, slug: `app-role-${team.id}` } });
      const version = await db.workTypeVersion.create({ data: { teamId: team.id, workTypeId: workType.id, version: 1, definition: { v: 1 } } });
      const item = await db.item.create({ data: { teamId: team.id, workTypeVersionId: version.id, data: {} } });
      await db.itemEvent.create({ data: { itemId: item.id, seq: 1, type: 'item.created', payload: {} } });
      await asApp(async (client) => {
        const error = await sqlState(client, `DELETE FROM "ItemEvent" WHERE "itemId" = '${item.id}'`);
        expect(error.message).toMatch(/ItemEvent is append-only/);
      });
    } finally {
      await db.$disconnect();
    }
  });

  // #121: what every role inherits from PUBLIC by default, revoked.
  it('refuses CREATE TEMPORARY TABLE with 42501 (no TEMPORARY inherited from PUBLIC)', async () => {
    await asApp(async (client) => {
      const error = await sqlState(client, 'CREATE TEMPORARY TABLE t (id int)');
      expect(error.code).toBe('42501');
      expect(error.message).toMatch(/permission denied to create temporary tables/);
    });
  });

  it('gives no EXECUTE on the migrations\' functions in schema public', async () => {
    const { rows } = await admin.query(
      `SELECT p.proname, has_function_privilege($1, p.oid, 'EXECUTE') AS execute
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($2) ORDER BY p.proname`,
      [APP_ROLE_NAME, ['item_event_append_only', 'work_type_version_immutable']],
    );
    expect(rows).toEqual([
      { proname: 'item_event_append_only', execute: false },
      { proname: 'work_type_version_immutable', execute: false },
    ]);
  });

  it('refuses a function the migration user created before the role step with 42501', async () => {
    const fn = `app_role_earlier_${randomUUID().slice(0, 8)}`;
    await admin.query(`CREATE FUNCTION "${fn}"() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
    // beforeAll's default privilege already withholds EXECUTE from a new function; give it back, as
    // Postgres's built-in default does for the functions migrations created before #121.
    await admin.query(`GRANT EXECUTE ON FUNCTION "${fn}"() TO PUBLIC`);
    try {
      expect(runRoleStep()).toBe(0);
      await asApp(async (client) => expect((await sqlState(client, `SELECT "${fn}"()`)).code).toBe('42501'));
    } finally {
      await admin.query(`DROP FUNCTION "${fn}"()`);
    }
  }, 60_000);

  it('refuses a function a later migration creates with 42501 (default privileges)', async () => {
    const fn = `app_role_later_${randomUUID().slice(0, 8)}`;
    await admin.query(`CREATE FUNCTION "${fn}"() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
    try {
      await asApp(async (client) => expect((await sqlState(client, `SELECT "${fn}"()`)).code).toBe('42501'));
    } finally {
      await admin.query(`DROP FUNCTION "${fn}"()`);
    }
  });

  it('still fires the append-only and immutable triggers for getworkdone_app (no EXECUTE needed to fire them)', async () => {
    const db = createPrismaClient(appUrl());
    try {
      const team = await db.team.create({ data: { name: 'app role triggers' } });
      const workType = await db.workType.create({ data: { teamId: team.id, slug: `app-role-trig-${team.id}` } });
      const version = await db.workTypeVersion.create({ data: { teamId: team.id, workTypeId: workType.id, version: 1, definition: { v: 1 } } });
      await asApp(async (client) => {
        const error = await sqlState(client, `UPDATE "WorkTypeVersion" SET version = 2 WHERE id = '${version.id}'`);
        expect(error.message).toMatch(/WorkTypeVersion is immutable/);
      });
    } finally {
      await db.$disconnect();
    }
  });

  it('refuses SELECT rolpassword FROM pg_authid with 42501', async () => {
    await asApp(async (client) => expect((await sqlState(client, 'SELECT rolpassword FROM pg_authid')).code).toBe('42501'));
  });

  it('gives no access to Prisma\'s _prisma_migrations', async () => {
    await asApp(async (client) => expect((await sqlState(client, 'SELECT 1 FROM _prisma_migrations')).code).toBe('42501'));
  });

  it('is a role with no attribute beyond LOGIN, owning nothing', async () => {
    const { rows } = await admin.query(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin,
              (SELECT count(*)::int FROM pg_class c WHERE c.relowner = r.oid) AS owned
       FROM pg_roles r WHERE rolname = $1`,
      [APP_ROLE_NAME],
    );
    expect(rows).toEqual([{ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolcanlogin: true, owned: 0 }]);
  });

  it('covers a table a later migration creates (default privileges)', async () => {
    const table = `app_role_later_${randomUUID().slice(0, 8)}`;
    await admin.query(`CREATE TABLE "${table}" (id int)`);
    try {
      await asApp(async (client) => {
        await client.query(`INSERT INTO "${table}" (id) VALUES (1)`);
        expect((await client.query(`SELECT id FROM "${table}"`)).rows).toEqual([{ id: 1 }]);
      });
    } finally {
      await admin.query(`DROP TABLE "${table}"`);
    }
  });

  // The migrate task sends a verifier, never the password (app-role.ts); Postgres's own must match it.
  it('stores a SCRAM-SHA-256 verifier that Postgres itself computes for the same password and salt', async () => {
    const throwaway = `app_role_scram_${randomUUID().slice(0, 8)}`;
    await admin.query(`SET password_encryption = 'scram-sha-256'`);
    await admin.query(`CREATE ROLE ${throwaway} PASSWORD 'pg-own-${throwaway}'`);
    try {
      const { rows } = await admin.query('SELECT rolpassword FROM pg_authid WHERE rolname = $1', [throwaway]);
      const stored = rows[0].rolpassword as string;
      const salt = Buffer.from(/^SCRAM-SHA-256\$4096:([^$]+)\$/.exec(stored)![1]!, 'base64');
      expect(scramSha256Verifier(`pg-own-${throwaway}`, salt)).toBe(stored);
    } finally {
      await admin.query(`DROP ROLE ${throwaway}`);
    }
  });

  it('runs twice without error and leaves the role working (idempotent)', async () => {
    expect(runRoleStep()).toBe(0);
    await asApp(async (client) => expect((await client.query('SELECT count(*)::int AS n FROM "Team" WHERE id = $1', [teamId])).rows).toEqual([{ n: 1 }]));
  }, 60_000);
});

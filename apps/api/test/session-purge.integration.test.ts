import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createPrismaClient } from '@getworkdone/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { SessionPurge } from '../src/modules/auth/session-purge.js';
import { fakeWebDist } from './support/web-dist.js';

// Partition `integration`: the periodic purge of expired sign-ins, sessions, ended sign-in rate
// windows, ended quota windows and Identity rows past the retention rule against Postgres (GWP#16, GWP#32, GWP#50, GWP#143).
// The rows are written directly, with ids unique to this run.
describe('session purge', () => {
  let app: INestApplication;
  const db = createPrismaClient();
  const run = randomUUID().slice(0, 8);
  const id = (name: string) => `purge-${name}-${run}`;
  const at = (offsetMs: number) => new Date(Date.now() + offsetMs);

  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
  });
  afterAll(async () => {
    await db.loginAttempt.deleteMany({ where: { id: { startsWith: `purge-`, endsWith: run } } });
    await db.session.deleteMany({ where: { id: { startsWith: `purge-`, endsWith: run } } });
    await db.loginRateWindow.deleteMany({ where: { key: { startsWith: `purge-`, endsWith: run } } });
    await db.quotaWindow.deleteMany({ where: { key: { startsWith: `purge-`, endsWith: run } } });
    await db.teamMember.deleteMany({ where: { subject: { startsWith: `purge-`, endsWith: run } } });
    await db.team.deleteMany({ where: { name: `purge-${run}` } });
    await db.identity.deleteMany({ where: { subject: { startsWith: `purge-`, endsWith: run } } });
    await app.close();
    await db.$disconnect();
  });

  const login = (name: string, expiresAt: Date) => db.loginAttempt.create({ data: { id: id(name), state: 's', nonce: 'n', codeVerifier: 'v', expiresAt } });
  const session = (name: string, expiresAt: Date) => db.session.create({ data: { id: id(name), subject: `purge-${run}`, email: 'p@example.test', csrfToken: 'c', expiresAt } });

  it('expired LoginAttempt and Session rows are deleted; unexpired rows stay', async () => {
    await login('login-old', at(-3_600_000));
    await login('login-just', at(-1));
    await login('login-live', at(600_000));
    await session('session-old', at(-86_400_000));
    await session('session-live', at(3_600_000));

    const deleted = await app.get(SessionPurge).runOnce();

    expect(deleted.loginAttempts).toBeGreaterThanOrEqual(2);
    expect(deleted.sessions).toBeGreaterThanOrEqual(1);
    const logins = await db.loginAttempt.findMany({ where: { id: { in: [id('login-old'), id('login-just'), id('login-live')] } }, select: { id: true } });
    expect(logins.map((r) => r.id)).toEqual([id('login-live')]);
    const sessions = await db.session.findMany({ where: { id: { in: [id('session-old'), id('session-live')] } }, select: { id: true } });
    expect(sessions.map((r) => r.id)).toEqual([id('session-live')]);
  });

  it('ended sign-in rate windows (a minute old or more) are deleted; a live window stays (GWP#32)', async () => {
    for (const [name, offsetMs] of [['window-old', -3_600_000], ['window-just', -60_000], ['window-live', -59_000]] as const) {
      await db.loginRateWindow.create({ data: { key: id(name), windowStart: at(offsetMs), count: 20 } });
    }
    const deleted = await app.get(SessionPurge).runOnce();
    expect(deleted.loginRateWindows).toBeGreaterThanOrEqual(2);
    const windows = await db.loginRateWindow.findMany({ where: { key: { in: [id('window-old'), id('window-just'), id('window-live')] } }, select: { key: true } });
    expect(windows.map((r) => r.key)).toEqual([id('window-live')]);
  });

  it('quota windows whose windowStart + windowMs has passed are deleted; live ones stay, an hourly or daily one included (GWP#50)', async () => {
    const HOUR = 3_600_000;
    const rows = [['quota-old', -2 * HOUR, HOUR], ['quota-just', -HOUR, HOUR], ['quota-live-hour', -HOUR + 60_000, HOUR], ['quota-live-day', -23 * HOUR, 24 * HOUR], ['quota-old-minute', -61_000, 60_000]] as const;
    for (const [name, offsetMs, windowMs] of rows) await db.quotaWindow.create({ data: { key: id(name), windowStart: at(offsetMs), windowMs, count: 3 } });
    const deleted = await app.get(SessionPurge).runOnce();
    expect(deleted.quotaWindows).toBeGreaterThanOrEqual(3);
    const windows = await db.quotaWindow.findMany({ where: { key: { in: rows.map(([name]) => id(name)) } }, select: { key: true }, orderBy: { key: 'asc' } });
    expect(windows.map((r) => r.key)).toEqual([id('quota-live-day'), id('quota-live-hour')]);
  });

  it('an Identity past the retention rule with no team and no live session is deleted; a member, a live session or a recent sign-in keeps it (GWP#143)', async () => {
    const DAY = 86_400_000;
    const names = ['identity-old', 'identity-member', 'identity-live-session', 'identity-recent', 'identity-expired-session'] as const;
    for (const name of names) await db.identity.create({ data: { subject: id(name), email: `${name}@example.test` } });
    // @updatedAt is set by Prisma on write, so the ages are set in SQL, as UTC like Prisma writes them.
    const age = async (name: string, offsetMs: number) => {
      await db.$executeRaw`UPDATE "Identity" SET "updatedAt" = ${at(offsetMs).toISOString().slice(0, -1)}::timestamp WHERE "subject" = ${id(name)}`;
    };
    await age('identity-old', -91 * DAY);
    await age('identity-member', -91 * DAY);
    await age('identity-live-session', -91 * DAY);
    await age('identity-recent', -89 * DAY);
    await age('identity-expired-session', -91 * DAY);
    const team = await db.team.create({ data: { name: `purge-${run}` } });
    await db.teamMember.create({ data: { teamId: team.id, subject: id('identity-member'), role: 'member' } });
    const sessionFor = (name: string, subject: string, expiresAt: Date) => db.session.create({ data: { id: id(name), subject, email: 'p@example.test', csrfToken: 'c', expiresAt } });
    await sessionFor('session-of-live', id('identity-live-session'), at(3_600_000));
    await sessionFor('session-of-expired', id('identity-expired-session'), at(-60_000));
    const before = await db.identity.findUnique({ where: { subject: id('identity-old') } });
    expect(before?.updatedAt.getTime()).toBeLessThan(Date.now() - 90 * DAY);

    const deleted = await app.get(SessionPurge).runOnce();

    expect(deleted.identities).toBeGreaterThanOrEqual(2);
    const left = await db.identity.findMany({ where: { subject: { in: names.map(id) } }, select: { subject: true }, orderBy: { subject: 'asc' } });
    expect(left.map((r) => r.subject)).toEqual([id('identity-live-session'), id('identity-member'), id('identity-recent')]);
  });

  it('after a purge run no LoginAttempt or Session row is past expiresAt', async () => {
    await login('login-old-2', at(-60_000));
    await session('session-old-2', at(-60_000));
    await app.get(SessionPurge).runOnce();
    // The acceptance query, with now(): the columns hold UTC without a time zone.
    const [counts] = await db.$queryRaw<{ logins: bigint; sessions: bigint }[]>`
      SELECT (SELECT count(*) FROM "LoginAttempt" WHERE "expiresAt" < (now() AT TIME ZONE 'UTC')) AS logins,
             (SELECT count(*) FROM "Session" WHERE "expiresAt" < (now() AT TIME ZONE 'UTC')) AS sessions`;
    expect(Number(counts?.logins)).toBe(0);
    expect(Number(counts?.sessions)).toBe(0);
  });
});

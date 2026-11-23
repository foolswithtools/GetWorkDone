import type { INestApplication } from '@nestjs/common';
import { createPrismaClient } from '@getworkdone/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { TeamsService } from '../src/modules/teams/teams.service.js';
import { definition } from './support/definitions.js';
import { signIn, type SignedIn } from './support/identity.js';
import { fakeWebDist } from './support/web-dist.js';

// Team membership (GWP#20, docs/auth.md "Team membership"): an admin lists, adds and removes a team's
// members; nobody else may, and a team always keeps an admin.
describe('team members', () => {
  let app: INestApplication;
  const db = createPrismaClient();
  const run = Math.random().toString(36).slice(2, 8);
  const subject = (name: string) => `${name}-${run}`;
  let admin: SignedIn;
  let teamId: string;
  const membersPath = () => `/api/v1/teams/${teamId}/members`;

  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
    admin = await signIn(app, subject('admin'));
    teamId = (await admin.post('/api/v1/teams', { name: `Members ${run}` }).expect(201)).body.id;
    await admin.post(`/api/v1/teams/${teamId}/work-types`, { slug: 'orders', definition: definition() }).expect(201);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('an admin adds a member (201), who then sees the team in GET /me and can read its work types', async () => {
    const dana = subject('dana');
    const added = await admin.post(membersPath(), { subject: dana, role: 'member' }).expect(201);
    // dana has not signed in yet: no email or display name (GWP#99, members-profile.integration.test.ts).
    expect(added.body).toEqual({ subject: dana, role: 'member', createdAt: expect.any(String), email: null, displayName: null });
    const listed = await admin.get(membersPath()).expect(200);
    expect(listed.body.map((m: { subject: string; role: string }) => [m.subject, m.role])).toEqual([[subject('admin'), 'admin'], [dana, 'member']]);

    const session = await signIn(app, dana);
    const me = await session.get('/api/v1/me').expect(200);
    expect(me.body.teams).toEqual([{ id: teamId, name: `Members ${run}`, role: 'member' }]);
    const workTypes = await session.get(`/api/v1/teams/${teamId}/work-types`).expect(200);
    expect(workTypes.body.map((w: { slug: string }) => w.slug)).toEqual(['orders']);
  });

  it('a member who is not an admin gets 403 on every members route, and nothing changes', async () => {
    const erin = subject('erin');
    await admin.post(membersPath(), { subject: erin, role: 'member' }).expect(201);
    const session = await signIn(app, erin);
    const before = await db.teamMember.count({ where: { teamId } });
    await session.get(membersPath()).expect(403);
    await session.post(membersPath(), { subject: subject('mallory'), role: 'admin' }).expect(403);
    await session.delete(`${membersPath()}/${encodeURIComponent(subject('admin'))}`).expect(403);
    expect(await db.teamMember.count({ where: { teamId } })).toBe(before);
    // Someone outside the team is 403 too (the team-member guard).
    const outsider = await signIn(app, subject('outsider'));
    await outsider.get(membersPath()).expect(403);
  });

  it('adding the same subject twice is 409 and writes one row; a malformed body is 400', async () => {
    const fay = subject('fay');
    await admin.post(membersPath(), { subject: fay, role: 'member' }).expect(201);
    await admin.post(membersPath(), { subject: fay, role: 'admin' }).expect(409);
    expect(await db.teamMember.findMany({ where: { teamId, subject: fay }, select: { role: true } })).toEqual([{ role: 'member' }]);
    await admin.post(membersPath(), { subject: '', role: 'member' }).expect(400);
    await admin.post(membersPath(), { subject: subject('gus'), role: 'owner' }).expect(400);
    await admin.post(membersPath(), { subject: subject('gus'), role: 'member', extra: true }).expect(400);
  });

  it('an admin removes a member (204), who then loses the team; an unknown subject is 404', async () => {
    const hal = subject('hal|with/slash');
    await admin.post(membersPath(), { subject: hal, role: 'member' }).expect(201);
    // A DELETE is a write: without the X-GWD-CSRF header it is 403 and the row stays.
    await request(app.getHttpServer()).delete(`${membersPath()}/${encodeURIComponent(hal)}`).set('cookie', admin.cookie).expect(403);
    expect(await db.teamMember.count({ where: { teamId, subject: hal } })).toBe(1);
    await admin.delete(`${membersPath()}/${encodeURIComponent(hal)}`).expect(204);
    expect(await db.teamMember.count({ where: { teamId, subject: hal } })).toBe(0);
    const session = await signIn(app, hal);
    expect((await session.get('/api/v1/me').expect(200)).body.teams).toEqual([]);
    await session.get(`/api/v1/teams/${teamId}/work-types`).expect(403);
    await admin.delete(`${membersPath()}/${encodeURIComponent(hal)}`).expect(404);
  });

  it('removing the last admin is 409 and the row stays; with a second admin, either may go', async () => {
    const { session, team } = await signInTeam();
    const path = `/api/v1/teams/${team}/members`;
    const self = encodeURIComponent(subject('solo'));
    await session.delete(`${path}/${self}`).expect(409);
    expect(await db.teamMember.findMany({ where: { teamId: team }, select: { subject: true, role: true } })).toEqual([{ subject: subject('solo'), role: 'admin' }]);

    // A member does not count as an admin.
    await session.post(path, { subject: subject('ivy'), role: 'member' }).expect(201);
    await session.delete(`${path}/${self}`).expect(409);
    // A second admin: now the first may leave, and the second is then the last.
    await session.post(path, { subject: subject('jo'), role: 'admin' }).expect(201);
    await session.delete(`${path}/${self}`).expect(204);
    const jo = await signIn(app, subject('jo'));
    await jo.delete(`${path}/${encodeURIComponent(subject('jo'))}`).expect(409);
    expect(await db.teamMember.count({ where: { teamId: team, role: 'admin' } })).toBe(1);
  });

  it('two admins removing each other at once leave one admin, never none', async () => {
    const { session, team } = await signInTeam('race');
    const path = `/api/v1/teams/${team}/members`;
    await session.post(path, { subject: subject('kim'), role: 'admin' }).expect(201);
    const kim = await signIn(app, subject('kim'));
    const results = await Promise.all([
      session.delete(`${path}/${encodeURIComponent(subject('kim'))}`),
      kim.delete(`${path}/${encodeURIComponent(subject('race'))}`),
    ]);
    // Whichever runs second finds either that its caller was removed (403) or that its target is the last admin (409).
    expect(results.map((r) => r.status).sort()).toEqual([204, expect.any(Number)]);
    expect([403, 409]).toContain(results.map((r) => r.status).sort()[1]);
    expect(await db.teamMember.count({ where: { teamId: team, role: 'admin' } })).toBe(1);
  });

  it('a removal waits on the team\'s row lock and counts the admins after it, so it sees a removal committed meanwhile', async () => {
    const { session, team } = await signInTeam('lock');
    await session.post(`/api/v1/teams/${team}/members`, { subject: subject('lee'), role: 'admin' }).expect(201);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
    // Another transaction holds the lock and removes lee, as a concurrent removal would.
    const holder = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Team" WHERE id = ${team} FOR NO KEY UPDATE`;
      locked();
      await released;
      await tx.teamMember.delete({ where: { teamId_subject: { teamId: team, subject: subject('lee') } } });
    }, { timeout: 10_000 });
    await lockHeld;
    let settled = false;
    const removal = app.get(TeamsService).removeMember(team, subject('lock')).then(() => 'removed', (error: unknown) => error).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    release();
    await holder;
    expect(((await removal) as { getStatus?: () => number }).getStatus?.()).toBe(409);
    expect(await db.teamMember.findMany({ where: { teamId: team }, select: { subject: true, role: true } })).toEqual([{ subject: subject('lock'), role: 'admin' }]);
  });

  async function signInTeam(name = 'solo'): Promise<{ session: SignedIn; team: string }> {
    const session = await signIn(app, subject(name));
    const team = (await session.post('/api/v1/teams', { name: `Solo ${name} ${run}` }).expect(201)).body.id as string;
    return { session, team };
  }
});

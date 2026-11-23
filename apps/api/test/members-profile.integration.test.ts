import type { INestApplication } from '@nestjs/common';
import { createPrismaClient } from '@getworkdone/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { signIn, type SignedIn } from './support/identity.js';
import { fakeWebDist } from './support/web-dist.js';

// Members by name (GWP#99, docs/auth.md "Team membership"): every sign-in upserts the person's Identity
// (email and display name, as the identity provider asserted them), and the team's admins see them in the
// members list; a member who has never signed in shows null for both.
describe('team members by display name and email', () => {
  let app: INestApplication;
  const db = createPrismaClient();
  const run = Math.random().toString(36).slice(2, 8);
  const subject = (name: string) => `${name}-${run}`;
  const email = (name: string) => `${name}-${run}@example.test`;
  let admin: SignedIn;
  let teamId: string;
  const membersPath = () => `/api/v1/teams/${teamId}/members`;

  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
    admin = await signIn(app, { subject: subject('admin'), email: email('admin'), displayName: `Admin ${run}` });
    teamId = (await admin.post('/api/v1/teams', { name: `Profiles ${run}` }).expect(201)).body.id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('a sign-in upserts the Identity, and a later sign-in with a new name updates it', async () => {
    const before = new Date();
    await signIn(app, { subject: subject('ana'), email: email('ana'), displayName: 'Ana' });
    const first = await db.identity.findUnique({ where: { subject: subject('ana') } });
    expect(first).toEqual({ subject: subject('ana'), email: email('ana'), displayName: 'Ana', updatedAt: expect.any(Date) });
    expect(first!.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);

    await signIn(app, { subject: subject('ana'), email: `new-${email('ana')}`, displayName: 'Ana Lopez' });
    expect(await db.identity.findUnique({ where: { subject: subject('ana') }, select: { email: true, displayName: true } }))
      .toEqual({ email: `new-${email('ana')}`, displayName: 'Ana Lopez' });
    // A provider that stops asserting a name clears it, as the session's displayName would be.
    await signIn(app, { subject: subject('ana'), email: email('ana') });
    expect(await db.identity.findUnique({ where: { subject: subject('ana') }, select: { displayName: true } })).toEqual({ displayName: null });
    expect(await db.identity.count({ where: { subject: subject('ana') } })).toBe(1);
  });

  it('a sign-in with the same email and name still moves updatedAt, so the retention rule counts from the last sign-in (GWP#143)', async () => {
    const who = { subject: subject('same'), email: email('same'), displayName: 'Same' };
    await signIn(app, who);
    await db.$executeRaw`UPDATE "Identity" SET "updatedAt" = '2026-01-01 00:00:00' WHERE "subject" = ${who.subject}`;
    const before = new Date();
    await signIn(app, who);
    const after = await db.identity.findUnique({ where: { subject: who.subject } });
    expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it('two first sign-ins of one subject at once both succeed and leave one Identity', async () => {
    const who = { subject: subject('twin'), email: email('twin'), displayName: 'Twin' };
    await Promise.all([signIn(app, who), signIn(app, who)]);
    expect(await db.identity.count({ where: { subject: subject('twin') } })).toBe(1);
  });

  it('the members list gives email and displayName for a member who has signed in, null for one who has not', async () => {
    await signIn(app, { subject: subject('bo'), email: email('bo'), displayName: 'Bo' });
    const added = await admin.post(membersPath(), { subject: subject('bo'), role: 'member' }).expect(201);
    expect(added.body).toEqual({ subject: subject('bo'), role: 'member', createdAt: expect.any(String), email: email('bo'), displayName: 'Bo' });
    const never = await admin.post(membersPath(), { subject: subject('never'), role: 'member' }).expect(201);
    expect(never.body).toEqual({ subject: subject('never'), role: 'member', createdAt: expect.any(String), email: null, displayName: null });

    const listed = await admin.get(membersPath()).expect(200);
    expect(listed.body).toEqual([
      { subject: subject('admin'), role: 'admin', createdAt: expect.any(String), email: email('admin'), displayName: `Admin ${run}` },
      { subject: subject('bo'), role: 'member', createdAt: expect.any(String), email: email('bo'), displayName: 'Bo' },
      { subject: subject('never'), role: 'member', createdAt: expect.any(String), email: null, displayName: null },
    ]);

    // Once the never-signed-in member signs in, the list shows them; a name-less provider gives email only.
    await signIn(app, { subject: subject('never'), email: email('never') });
    const after = await admin.get(membersPath()).expect(200);
    expect(after.body[2]).toEqual({ subject: subject('never'), role: 'member', createdAt: expect.any(String), email: email('never'), displayName: null });
  });

  it('a member who is not an admin, and someone outside the team, get 403 and no profile', async () => {
    const cy = await signIn(app, { subject: subject('cy'), email: email('cy'), displayName: 'Cy' });
    await admin.post(membersPath(), { subject: subject('cy'), role: 'member' }).expect(201);
    const member = await cy.get(membersPath()).expect(403);
    expect(JSON.stringify(member.body)).not.toContain(email('admin'));
    const outsider = await signIn(app, { subject: subject('out'), email: email('out'), displayName: 'Out' });
    const refused = await outsider.get(membersPath()).expect(403);
    expect(JSON.stringify(refused.body)).not.toContain(email('admin'));
  });

  it('removing a member leaves their Identity in place', async () => {
    await signIn(app, { subject: subject('dee'), email: email('dee'), displayName: 'Dee' });
    await admin.post(membersPath(), { subject: subject('dee'), role: 'member' }).expect(201);
    await admin.delete(`${membersPath()}/${encodeURIComponent(subject('dee'))}`).expect(204);
    expect((await admin.get(membersPath()).expect(200)).body.map((m: { subject: string }) => m.subject)).not.toContain(subject('dee'));
    expect(await db.identity.findUnique({ where: { subject: subject('dee') }, select: { email: true, displayName: true } }))
      .toEqual({ email: email('dee'), displayName: 'Dee' });
  });

  it('one sign-in updates the profile in every team the person belongs to', async () => {
    const other = (await admin.post('/api/v1/teams', { name: `Profiles b ${run}` }).expect(201)).body.id as string;
    await admin.post(membersPath(), { subject: subject('eli'), role: 'member' }).expect(201);
    await admin.post(`/api/v1/teams/${other}/members`, { subject: subject('eli'), role: 'member' }).expect(201);
    await signIn(app, { subject: subject('eli'), email: email('eli'), displayName: 'Eli' });
    for (const team of [teamId, other]) {
      const listed = (await admin.get(`/api/v1/teams/${team}/members`).expect(200)).body as { subject: string; displayName: string | null }[];
      expect(listed.find((m) => m.subject === subject('eli'))?.displayName).toBe('Eli');
    }
  });
});

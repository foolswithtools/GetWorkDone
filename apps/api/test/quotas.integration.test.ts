import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { ItemDetailResponse, WorkTypeDefinition, WorkTypeResponse } from '@getworkdone/contracts';
import { createPrismaClient } from '@getworkdone/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DEFAULT_QUOTAS, QuotaLimiter } from '../src/common/quota.js';
import { Database } from '../src/modules/database/database.js';
import { DeliveryWorker, LEASE_MS } from '../src/modules/distribute/delivery.worker.js';
import { DISTRIBUTE_RUNTIME, type DistributeRuntime } from '../src/modules/distribute/distribute.options.js';
import { signIn, type SignedIn } from './support/identity.js';
import { publicLookup, startReceiver, type Receiver } from './support/receiver.js';
import { fakeWebDist } from './support/web-dist.js';

// Partition `integration`: the quotas (GWP#50, docs/domain.md) through the real routes, the worker and
// Postgres. Every limit is set low through createApp, as distribute's options are; the quota clock defaults
// to the distribute clock (GWP#74), so the suite steps past a window instead of waiting. QuotaWindow rows outlive the
// file, so every subject is new to this run, and teams the suite does not test the quota on are written
// directly, so the fixtures spend no team quota.
const run = randomUUID().slice(0, 8);
const sub = (name: string) => `quota-${name}-${run}`;
const fields: WorkTypeDefinition['fields'] = [{ key: 'title', label: 'Title', type: 'text', required: true }];
const persist: WorkTypeDefinition['outputs'] = [{ id: 'keep', kind: 'persist', config: {} }];
const HOUR = 3_600_000;

describe('quotas', () => {
  let app: INestApplication;
  const db = createPrismaClient();
  let receiver: Receiver;
  let clock = new Date(Date.now() + 1_000);
  const signedIn = new Map<string, SignedIn>();
  let slugs = 0;

  const as = async (name: string): Promise<SignedIn> => {
    const found = signedIn.get(name);
    if (found) return found;
    const created = await signIn(app, sub(name));
    signedIn.set(name, created);
    return created;
  };
  /** A team written directly, with `admin` and any `members`. */
  const team = async (admin: string, members: string[] = []): Promise<string> =>
    (await db.team.create({ data: { name: `Quota ${run}`, members: { create: [{ subject: sub(admin), role: 'admin' }, ...members.map((m) => ({ subject: sub(m), role: 'member' as const }))] } } })).id;
  const createWorkType = (admin: SignedIn, teamId: string, outputs: WorkTypeDefinition['outputs'] = persist) =>
    admin.post(`/api/v1/teams/${teamId}/work-types`, { slug: `wt-${(slugs += 1)}`, definition: { fields, steps: [], outputs } });
  const workType = async (admin: SignedIn, teamId: string, outputs?: WorkTypeDefinition['outputs']): Promise<WorkTypeResponse> =>
    (await createWorkType(admin, teamId, outputs).expect(201)).body as WorkTypeResponse;
  const itemsPath = (teamId: string, workTypeId: string) => `/api/v1/teams/${teamId}/work-types/${workTypeId}/items`;

  beforeAll(async () => {
    receiver = await startReceiver();
    app = await createApp({
      webDistDir: fakeWebDist(), logger: false,
      distribute: { webhook: { fetch: receiver.fetch, lookup: publicLookup }, now: () => clock },
      quotas: {
        // No `now`: the quota clock defaults to the distribute clock (GWP#74).
        limits: { teamsPerSubjectPerDay: 2, workTypesPerTeam: 2, itemsPerSubjectPerMinute: 2, deliveriesPerTeamPerHour: 1, exportsPerTeamPerHour: 2 },
      },
    });
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    await receiver.close();
    await db.quotaWindow.deleteMany({ where: { key: { contains: run } } });
    await db.$disconnect();
  });

  it('the third POST /api/v1/teams by one subject in a day answers 429 with Retry-After and writes no Team; another subject still creates one', async () => {
    const founder = await as('founder');
    await founder.post('/api/v1/teams', { name: 'One' }).expect(201);
    await founder.post('/api/v1/teams', { name: 'Two' }).expect(201);
    const refused = await founder.post('/api/v1/teams', { name: 'Three' }).expect(429);
    const retryAfter = Number(refused.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
    expect(refused.body.message).toMatch(/teams/);
    // Taken before the body is read: an invalid body past the limit is refused the same way.
    await founder.post('/api/v1/teams', {}).expect(429);
    expect(await db.team.count({ where: { members: { some: { subject: sub('founder') } } } })).toBe(2);
    expect(((await founder.get('/api/v1/teams').expect(200)).body as unknown[])).toHaveLength(2);
    await (await as('second-founder')).post('/api/v1/teams', { name: 'Theirs' }).expect(201);
  });

  it('a team\'s third work type (limit 2) answers 409 and writes no row', async () => {
    const admin = await as('wt-admin');
    const teamId = await team('wt-admin');
    await workType(admin, teamId);
    await workType(admin, teamId);
    const refused = await createWorkType(admin, teamId).expect(409);
    expect(refused.body.message).toBe('This team has reached its limit of 2 work types');
    expect(await db.workType.count({ where: { teamId } })).toBe(2);
  });

  describe('archived work types do not count against the cap (GWP#103)', () => {
    const workTypePath = (teamId: string, workTypeId: string, action: 'archive' | 'unarchive') => `/api/v1/teams/${teamId}/work-types/${workTypeId}/${action}`;
    const active = (teamId: string) => db.workType.count({ where: { teamId, archivedAt: null } });

    it('at the cap, archiving one work type lets a create succeed', async () => {
      const admin = await as('wt-archive-frees');
      const teamId = await team('wt-archive-frees');
      const first = await workType(admin, teamId);
      await workType(admin, teamId);
      await createWorkType(admin, teamId).expect(409);
      await admin.post(workTypePath(teamId, first.id, 'archive'), {}).expect(200);
      await createWorkType(admin, teamId).expect(201);
      expect(await active(teamId)).toBe(2);
      expect(await db.workType.count({ where: { teamId } })).toBe(3);
    });

    it('at the cap with one archived, unarchiving it answers 409 with the cap message and it stays archived', async () => {
      const admin = await as('wt-unarchive-refused');
      const teamId = await team('wt-unarchive-refused');
      const archived = await workType(admin, teamId);
      await admin.post(workTypePath(teamId, archived.id, 'archive'), {}).expect(200);
      await workType(admin, teamId);
      await workType(admin, teamId);
      const before = await db.workType.findUniqueOrThrow({ where: { id: archived.id } });
      const refused = await admin.post(workTypePath(teamId, archived.id, 'unarchive'), {}).expect(409);
      expect(refused.body.message).toBe('This team has reached its limit of 2 work types');
      expect(await db.workType.findUniqueOrThrow({ where: { id: archived.id } })).toEqual(before);
      expect(before.archivedAt).not.toBeNull();
      expect(await active(teamId)).toBe(2);
    });

    it('at the cap, unarchiving an already-active work type answers 200 and changes nothing', async () => {
      const admin = await as('wt-unarchive-active');
      const teamId = await team('wt-unarchive-active');
      const first = await workType(admin, teamId);
      await workType(admin, teamId);
      const before = await db.workType.findUniqueOrThrow({ where: { id: first.id } });
      const answered = await admin.post(workTypePath(teamId, first.id, 'unarchive'), {}).expect(200);
      expect((answered.body as WorkTypeResponse)).toMatchObject({ id: first.id, archivedAt: null });
      expect(await db.workType.findUniqueOrThrow({ where: { id: first.id } })).toEqual(before);
      expect(await active(teamId)).toBe(2);
    });

    it('unarchiving an unknown id answers 404', async () => {
      const admin = await as('wt-unarchive-unknown');
      const teamId = await team('wt-unarchive-unknown');
      await admin.post(workTypePath(teamId, randomUUID(), 'unarchive'), {}).expect(404);
    });

    it('with one place left and two archived, two unarchives at once leave exactly one 200 and one 409', async () => {
      const admin = await as('wt-unarchive-race');
      const teamId = await team('wt-unarchive-race');
      const a = await workType(admin, teamId);
      const b = await workType(admin, teamId);
      await admin.post(workTypePath(teamId, a.id, 'archive'), {}).expect(200);
      await admin.post(workTypePath(teamId, b.id, 'archive'), {}).expect(200);
      await workType(admin, teamId);
      const statuses = (await Promise.all([a, b].map((w) => admin.post(workTypePath(teamId, w.id, 'unarchive'), {})))).map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409]);
      expect(await active(teamId)).toBe(2);
    });
  });

  it('six outputs, or 21 email recipients in all, answer 422 at definition.outputs and write no row; five outputs and 20 recipients pass', async () => {
    const admin = await as('outputs-admin');
    const teamId = await team('outputs-admin');
    const keep = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `keep-${i}`, kind: 'persist' as const, config: {} }));
    const mail = (id: string, n: number) => ({ id, kind: 'email' as const, config: { recipients: Array.from({ length: n }, (_, i) => `${id}${i}@example.com`) } });

    expect((await createWorkType(admin, teamId, keep(6)).expect(422)).body.errors['definition.outputs']).toEqual(['At most 5 outputs']);
    expect((await createWorkType(admin, teamId, [mail('a', 11), mail('b', 10)]).expect(422)).body.errors['definition.outputs'])
      .toEqual(['At most 20 recipients across all email outputs']);
    expect(await db.workType.count({ where: { teamId } })).toBe(0);
    await createWorkType(admin, teamId, keep(5)).expect(201);
    await createWorkType(admin, teamId, [mail('a', 10), mail('b', 10)]).expect(201);
  });

  it('the third item in a minute answers 429 for a member and an admin alike, writes no Item or ItemEvent, and counts the subject on every team', async () => {
    const admin = await as('items-admin');
    const member = await as('items-member');
    const teamId = await team('items-admin', ['items-member']);
    const { id: workTypeId } = await workType(admin, teamId);
    const counts = async () => ({
      items: await db.item.count({ where: { teamId } }),
      events: await db.itemEvent.count({ where: { item: { teamId } } }),
    });

    for (const who of [member, admin]) {
      await who.post(itemsPath(teamId, workTypeId), { data: { title: 'One' } }).expect(201);
      await who.post(itemsPath(teamId, workTypeId), { data: { title: 'Two' } }).expect(201);
      const before = await counts();
      const refused = await who.post(itemsPath(teamId, workTypeId), { data: { title: 'Three' } }).expect(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(60);
      expect(await counts()).toEqual(before);
    }

    // The same member on a team of their own: the key is the subject, not the team.
    const otherTeam = await team('items-other-admin', ['items-member']);
    const other = await workType(await as('items-other-admin'), otherTeam);
    await member.post(itemsPath(otherTeam, other.id), { data: { title: 'Elsewhere' } }).expect(429);
    expect(await db.item.count({ where: { teamId: otherTeam } })).toBe(0);

    // A new minute starts a new window.
    clock = new Date(clock.getTime() + 60_000);
    await member.post(itemsPath(teamId, workTypeId), { data: { title: 'Next minute' } }).expect(201);
  });

  it('a team past its delivery quota has the rest deferred, not failed: pending, attempts back, quota_deferred, due at the window\'s end', async () => {
    const admin = await as('deliver-admin');
    const teamId = await team('deliver-admin');
    const { id: workTypeId } = await workType(admin, teamId, [{ id: 'hook', kind: 'webhook', config: { url: `${receiver.origin}/ok` } }]);
    const itemIds: string[] = [];
    for (const title of ['First', 'Second']) itemIds.push(((await admin.post(itemsPath(teamId, workTypeId), { data: { title } }).expect(201)).body as ItemDetailResponse).id);
    receiver.received.length = 0;
    const worker = app.get(DeliveryWorker);
    const windowStart = clock.getTime();

    expect(await worker.runOnce({ itemIds })).toBe(1);
    expect(receiver.received).toHaveLength(1);
    const rows = await db.delivery.findMany({ where: { itemId: { in: itemIds } } });
    const deferred = rows.filter((r) => r.status === 'pending');
    expect(rows.filter((r) => r.status === 'delivered')).toHaveLength(1);
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({ attempts: 0, lastError: 'quota_deferred', nextAttemptAt: new Date(windowStart + HOUR) });
    expect(await db.itemEvent.count({ where: { itemId: { in: itemIds }, type: 'delivery_failed' } })).toBe(0);

    // Still inside the window: nothing is due.
    clock = new Date(windowStart + HOUR - 1_000);
    expect(await worker.runOnce({ itemIds })).toBe(0);
    // Past it, the next claim sends it.
    clock = new Date(windowStart + HOUR);
    expect(await worker.runOnce({ itemIds })).toBe(1);
    expect(receiver.received).toHaveLength(2);
    expect(await db.delivery.findUniqueOrThrow({ where: { id: deferred[0]!.id } })).toMatchObject({ status: 'delivered', attempts: 1, lastError: null });
  });

  it('the third export in an hour answers 429 with Retry-After even for another work type of the team; the 30 s per work type still applies', async () => {
    const admin = await as('export-admin');
    const teamId = await team('export-admin');
    const output: WorkTypeDefinition['outputs'] = [{ id: 'file', kind: 'export', config: { format: 'csv' } }];
    const first = await workType(admin, teamId, output);
    const second = await workType(admin, teamId, output);
    const exportsPath = (id: string) => `/api/v1/teams/${teamId}/work-types/${id}/exports`;

    await admin.post(exportsPath(first.id), {}).expect(201);
    const tooSoon = await admin.post(exportsPath(first.id), {}).expect(429);
    expect(tooSoon.body.message).toMatch(/30 seconds/);
    expect(Number(tooSoon.headers['retry-after'])).toBeLessThanOrEqual(30);
    const overQuota = await admin.post(exportsPath(second.id), {}).expect(429);
    expect(overQuota.body.message).toMatch(/exports/);
    expect(Number(overQuota.headers['retry-after'])).toBeGreaterThan(30);
    expect(Number(overQuota.headers['retry-after'])).toBeLessThanOrEqual(3_600);
    expect(await db.export.count({ where: { teamId } })).toBe(1);
  });

  it('a quota take that throws reverts the claim\'s attempt and keeps the lease; three in a row never end the row interrupted (GWP#74)', async () => {
    const admin = await as('take-fails-admin');
    const teamId = await team('take-fails-admin');
    const { id: workTypeId } = await workType(admin, teamId, [{ id: 'hook', kind: 'webhook', config: { url: `${receiver.origin}/ok` } }]);
    const itemIds = [((await admin.post(itemsPath(teamId, workTypeId), { data: { title: 'Unlucky' } }).expect(201)).body as ItemDetailResponse).id];
    receiver.received.length = 0;
    const unreachable = new QuotaLimiter({ store: { take: () => Promise.reject(new Error('quota store unreachable')) }, limits: DEFAULT_QUOTAS, now: () => clock });
    const failing = new DeliveryWorker(app.get(Database), app.get<DistributeRuntime>(DISTRIBUTE_RUNTIME), unreachable);

    for (let claim = 1; claim <= 3; claim += 1) {
      const leasedFrom = clock.getTime();
      expect(await failing.runOnce({ itemIds }), `claim ${claim}`).toBe(0);
      const [row] = await db.delivery.findMany({ where: { itemId: itemIds[0] } });
      expect(row, `claim ${claim}`).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: new Date(leasedFrom + LEASE_MS) });
      clock = new Date(leasedFrom + LEASE_MS);
    }
    expect(receiver.received).toHaveLength(0);

    // The store back, the next claim sends it as its first attempt.
    expect(await app.get(DeliveryWorker).runOnce({ itemIds })).toBe(1);
    expect(receiver.received).toHaveLength(1);
    expect(await db.delivery.findFirstOrThrow({ where: { itemId: itemIds[0] } })).toMatchObject({ status: 'delivered', attempts: 1 });
    expect(await db.itemEvent.count({ where: { itemId: itemIds[0], type: 'delivery_failed' } })).toBe(0);
  });
});

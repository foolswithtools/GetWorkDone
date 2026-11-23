import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import type { ItemDetailResponse, ItemPage, WorkTypeDefinition } from '@getworkdone/contracts';
import { createPrismaClient } from '@getworkdone/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ITEM_PAGE_SIZE } from '../src/modules/items/items.service.js';
import { signIn, type SignedIn } from './support/identity.js';
import { fakeWebDist } from './support/web-dist.js';

// The waiting-for-me queue (GWP#55, docs/process.md "The API"), through the real routes and Postgres:
// GET /api/v1/teams/:teamId/items?waiting=me lists the team's `in_progress` items waiting at a human step
// whose assigneeRole the caller holds (an admin holds `admin` and `member`), across every work type,
// newest first, a page at a time. It reads Item.waitingRole, which each transition sets or clears, and
// which the migration backfilled for items already waiting.
const run = randomUUID().slice(0, 8);
const sub = (name: string) => `queue-${name}-${run}`;

const fields: WorkTypeDefinition['fields'] = [
  { key: 'title', label: 'Title', type: 'text', required: true },
  { key: 'reference', label: 'Reference', type: 'text', required: false },
];
const persist: WorkTypeDefinition['outputs'] = [{ id: 'keep', kind: 'persist', config: {} }];
const memberStep = { id: 'review', name: 'Review', kind: 'human', assigneeRole: 'member' } as const;
const adminStep = { id: 'approve', name: 'Approve', kind: 'human', assigneeRole: 'admin' } as const;
const need = { id: 'need', name: 'Needs a reference', kind: 'automated', transform: 'require_fields', params: { fields: ['reference'] } } as const;

describe('the waiting-for-me queue', () => {
  let app: INestApplication;
  const db = createPrismaClient();
  let admin: SignedIn;
  let member: SignedIn;
  let outsider: SignedIn;
  let teamId: string;
  let slugs = 0;

  async function workType(definition: WorkTypeDefinition, team = teamId): Promise<{ id: string; versionId: string }> {
    slugs += 1;
    const body = (await admin.post(`/api/v1/teams/${team}/work-types`, { slug: `wt-${slugs}`, definition }).expect(201)).body as { id: string; version: { id: string } };
    return { id: body.id, versionId: body.version.id };
  }

  async function capture(workTypeId: string, data: Record<string, unknown> = { title: 'x' }, as = member, team = teamId): Promise<ItemDetailResponse> {
    return (await as.post(`/api/v1/teams/${team}/work-types/${workTypeId}/items`, { data }).expect(201)).body as ItemDetailResponse;
  }

  const queue = async (as: SignedIn, query = '', team = teamId) => (await as.get(`/api/v1/teams/${team}/items?waiting=me${query}`).expect(200)).body as ItemPage;
  const ids = (page: ItemPage) => page.items.map((i) => i.id);
  const waitingRole = async (itemId: string) => (await db.item.findUniqueOrThrow({ where: { id: itemId }, select: { waitingRole: true } })).waitingRole;

  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
    admin = await signIn(app, sub('admin'));
    member = await signIn(app, sub('member'));
    outsider = await signIn(app, sub('outsider'));
    teamId = (await admin.post('/api/v1/teams', { name: 'Queue' }).expect(201)).body.id;
    await admin.post(`/api/v1/teams/${teamId}/members`, { subject: sub('member'), role: 'member' }).expect(201);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('a member sees the items waiting at member steps across two work types and none at admin steps; an admin sees both, newest first', async () => {
    const first = await capture((await workType({ fields, outputs: persist, steps: [memberStep] })).id, { title: 'first' });
    const second = await capture((await workType({ fields, outputs: persist, steps: [memberStep] })).id, { title: 'second' });
    const forAdmin = await capture((await workType({ fields, outputs: persist, steps: [adminStep] })).id, { title: 'for admin' });
    const done = await capture((await workType({ fields, outputs: persist, steps: [] })).id, { title: 'no steps' });
    expect(done.status).toBe('completed');

    const mine = await queue(member);
    expect(ids(mine)).toEqual([second.id, first.id]);
    expect(mine.nextCursor).toBeNull();
    expect(mine.items[0]).toMatchObject({ id: second.id, status: 'in_progress', data: { title: 'second' } });
    expect(ids(await queue(admin))).toEqual([forAdmin.id, second.id, first.id]);
    expect(await waitingRole(first.id)).toBe('member');
    expect(await waitingRole(forAdmin.id)).toBe('admin');
    expect(await waitingRole(done.id)).toBeNull();

    // ?status= (GWP#54) narrows the same list: only `in_progress` items ever wait.
    expect(ids(await queue(member, '&status=in_progress'))).toEqual([second.id, first.id]);
    expect(ids(await queue(member, '&status=completed'))).toEqual([]);
  });

  it('a completed step takes the item off the queue; waitingRole is null after it', async () => {
    const wt = await workType({ fields, outputs: persist, steps: [memberStep, adminStep] });
    const item = await capture(wt.id);
    expect(ids(await queue(member))).toContain(item.id);
    const moved = (await member.post(`/api/v1/teams/${teamId}/items/${item.id}/steps/review/complete`, { rowVersion: item.rowVersion }).expect(200)).body as ItemDetailResponse;
    // Now waiting at the admin step: off the member's queue, on the admin's.
    expect(ids(await queue(member))).not.toContain(item.id);
    expect(ids(await queue(admin))).toContain(item.id);
    expect(await waitingRole(item.id)).toBe('admin');
    await admin.post(`/api/v1/teams/${teamId}/items/${item.id}/steps/approve/complete`, { rowVersion: moved.rowVersion }).expect(200);
    expect(ids(await queue(admin))).not.toContain(item.id);
    expect(await db.item.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: 'completed', waitingRole: null });
  });

  it('waitingRole is null after a failure, after a cancel, and kept through a data edit on a waiting item', async () => {
    const failing = await capture((await workType({ fields, outputs: persist, steps: [need, memberStep] })).id, { title: 'no ref' });
    expect(failing.status).toBe('failed');
    expect(await waitingRole(failing.id)).toBeNull();

    const waiting = await capture((await workType({ fields, outputs: persist, steps: [memberStep] })).id, { title: 'to edit' });
    const edited = (await admin.post(`/api/v1/teams/${teamId}/items/${waiting.id}/data`, { rowVersion: waiting.rowVersion, data: { title: 'edited' } }).expect(200)).body as ItemDetailResponse;
    // A data edit moves no step: the item still waits, and stays on the queue.
    expect(await waitingRole(waiting.id)).toBe('member');
    expect(ids(await queue(member))).toContain(waiting.id);
    await admin.post(`/api/v1/teams/${teamId}/items/${waiting.id}/cancel`, { rowVersion: edited.rowVersion }).expect(200);
    expect(await waitingRole(waiting.id)).toBeNull();
    expect(ids(await queue(member))).not.toContain(waiting.id);
  });

  it('the cursor pages the queue, each item once', async () => {
    const team = (await admin.post('/api/v1/teams', { name: 'Queue paging' }).expect(201)).body.id as string;
    const wt = await workType({ fields, outputs: persist, steps: [memberStep] }, team);
    const created = [];
    for (let i = 0; i < ITEM_PAGE_SIZE + 2; i += 1) created.push(await capture(wt.id, { title: `item ${i}` }, admin, team));
    const first = await queue(admin, '', team);
    expect(first.items).toHaveLength(ITEM_PAGE_SIZE);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await queue(admin, `&cursor=${first.nextCursor}`, team);
    expect(second.nextCursor).toBeNull();
    expect([...ids(first), ...ids(second)]).toEqual(created.map((i) => i.id).reverse());
  });

  it('without ?waiting=me, or with a bad cursor or status, the list is 400; a non-member is 403', async () => {
    await member.get(`/api/v1/teams/${teamId}/items`).expect(400);
    await member.get(`/api/v1/teams/${teamId}/items?waiting=you`).expect(400);
    await member.get(`/api/v1/teams/${teamId}/items?waiting=me&waiting=me`).expect(400);
    await member.get(`/api/v1/teams/${teamId}/items?waiting=me&cursor=nope`).expect(400);
    await member.get(`/api/v1/teams/${teamId}/items?waiting=me&status=stuck`).expect(400);
    await outsider.get(`/api/v1/teams/${teamId}/items?waiting=me`).expect(403);
  });

  it('another team\'s waiting items never appear', async () => {
    const other = (await outsider.post('/api/v1/teams', { name: 'Queue other' }).expect(201)).body.id as string;
    slugs += 1;
    const wt = (await outsider.post(`/api/v1/teams/${other}/work-types`, { slug: `wt-${slugs}`, definition: { fields, outputs: persist, steps: [memberStep] } }).expect(201)).body.id as string;
    const theirs = await capture(wt, { title: 'theirs' }, outsider, other);
    expect(ids(await queue(admin))).not.toContain(theirs.id);
    expect(ids(await queue(outsider, '', other))).toEqual([theirs.id]);
  });

  it('the migration\'s backfill sets waitingRole for an item already waiting at a human step, and only for those', async () => {
    const wt = await workType({ fields, outputs: persist, steps: [need, adminStep] });
    // Rows as the engine wrote them before waitingRole existed: one waiting at the admin step (its data
    // edited since, which moves no step), one stopped before its first step, one failed.
    const waiting = await db.item.create({ data: { teamId, workTypeVersionId: wt.versionId, data: { title: 'old' }, status: 'in_progress', currentStepIndex: 1, rowVersion: 4 } });
    const stopped = await db.item.create({ data: { teamId, workTypeVersionId: wt.versionId, data: { title: 'stopped' }, status: 'in_progress', currentStepIndex: 1, rowVersion: 3 } });
    const failed = await db.item.create({ data: { teamId, workTypeVersionId: wt.versionId, data: { title: 'failed' }, status: 'failed', currentStepIndex: 0, rowVersion: 2 } });
    const event = (itemId: string, seq: number, type: string, payload: object = {}) => ({ itemId, seq, type, actorSubject: null, payload });
    await db.itemEvent.createMany({
      data: [
        event(waiting.id, 1, 'captured'), event(waiting.id, 2, 'step_started', { stepId: 'need', stepIndex: 0, kind: 'automated' }),
        event(waiting.id, 3, 'step_completed', { stepId: 'need', stepIndex: 0, kind: 'automated' }),
        event(waiting.id, 4, 'step_started', { stepId: 'approve', stepIndex: 1, kind: 'human', assigneeRole: 'admin' }),
        event(waiting.id, 5, 'data_edited', { fields: ['title'] }),
        event(stopped.id, 1, 'captured'), event(stopped.id, 2, 'step_started', { stepId: 'need', stepIndex: 0, kind: 'automated' }),
        event(stopped.id, 3, 'step_completed', { stepId: 'need', stepIndex: 0, kind: 'automated' }),
        event(failed.id, 1, 'captured'), event(failed.id, 2, 'step_started', { stepId: 'need', stepIndex: 0, kind: 'automated' }),
        event(failed.id, 3, 'step_failed', { stepId: 'need', stepIndex: 0, kind: 'automated' }),
      ],
    });
    expect(await waitingRole(waiting.id)).toBeNull();

    await db.$executeRawUnsafe(backfillStatement());

    expect(await waitingRole(waiting.id)).toBe('admin');
    expect(await waitingRole(stopped.id)).toBeNull();
    expect(await waitingRole(failed.id)).toBeNull();
    expect(ids(await queue(admin))).toContain(waiting.id);
  });
});

/** The backfill UPDATE of the waiting_role_and_archive migration, between its marker comments. */
function backfillStatement(): string {
  const dir = new URL('../../../packages/db/prisma/migrations/', import.meta.url);
  const sql = readFileSync(new URL('20261031120000_waiting_role_and_archive/migration.sql', dir), 'utf8');
  const found = /-- backfill:begin\n([\s\S]*?)-- backfill:end/.exec(sql)?.[1];
  if (!found) throw new Error('the migration has no backfill block');
  return found.trim().replace(/;$/, '');
}

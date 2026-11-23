import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { ItemDetailResponse, WorkTypeDefinition } from '@getworkdone/contracts';
import { createPrismaClient } from '@getworkdone/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { signIn, type SignedIn } from './support/identity.js';
import { fakeWebDist } from './support/web-dist.js';

// An admin corrects an item's data before a retry (GWP#23, docs/process.md "Editing data"), through the
// real routes and Postgres: POST .../items/:itemId/data replaces the data of a `failed` item, or of one
// waiting at a human step, as one guarded transition with one `data_edited` event naming the changed keys.
const run = randomUUID().slice(0, 8);
const sub = (name: string) => `item-data-${name}-${run}`;

const fields: WorkTypeDefinition['fields'] = [
  { key: 'title', label: 'Title', type: 'text', required: true },
  { key: 'reference', label: 'Reference', type: 'text', required: false },
  { key: 'qty', label: 'Quantity', type: 'number', required: false, min: 1 },
];
const outputs: WorkTypeDefinition['outputs'] = [{ id: 'keep', kind: 'persist', config: {} }];
const need = { id: 'need', name: 'Needs a reference', kind: 'automated', transform: 'require_fields', params: { fields: ['reference'] } } as const;
const review = { id: 'review', name: 'Review', kind: 'human', assigneeRole: 'member' } as const;
const approve = { id: 'approve', name: 'Approve', kind: 'human', assigneeRole: 'admin' } as const;

describe('editing an item\'s data', () => {
  let app: INestApplication;
  const db = createPrismaClient();
  let admin: SignedIn;
  let member: SignedIn;
  let outsider: SignedIn;
  let teamId: string;
  let slugs = 0;

  async function workType(definition: WorkTypeDefinition): Promise<string> {
    slugs += 1;
    return (await admin.post(`/api/v1/teams/${teamId}/work-types`, { slug: `wt-${slugs}`, definition }).expect(201)).body.id as string;
  }

  async function capture(workTypeId: string, data: Record<string, unknown>): Promise<ItemDetailResponse> {
    return (await member.post(`/api/v1/teams/${teamId}/work-types/${workTypeId}/items`, { data }).expect(201)).body as ItemDetailResponse;
  }

  const dataPath = (itemId: string) => `/api/v1/teams/${teamId}/items/${itemId}/data`;
  const stepPath = (itemId: string, stepId: string, action: 'complete' | 'retry') => `/api/v1/teams/${teamId}/items/${itemId}/steps/${stepId}/${action}`;
  const events = async (itemId: string) => (await db.itemEvent.findMany({ where: { itemId }, orderBy: { seq: 'asc' } })).map((e) => ({ seq: e.seq, type: e.type, actorSubject: e.actorSubject, payload: e.payload }));
  const row = (itemId: string) => db.item.findUniqueOrThrow({ where: { id: itemId } });

  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
    admin = await signIn(app, sub('admin'));
    member = await signIn(app, sub('member'));
    outsider = await signIn(app, sub('outsider'));
    teamId = (await admin.post('/api/v1/teams', { name: 'Item data' }).expect(201)).body.id;
    await admin.post(`/api/v1/teams/${teamId}/members`, { subject: sub('member'), role: 'member' }).expect(201);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('an item failed by require_fields reaches `completed` through the API alone: edit, retry, complete the human steps', async () => {
    const failed = await capture(await workType({ fields, outputs, steps: [need, review, approve] }), { title: 'new laptop', qty: 2 });
    expect(failed).toMatchObject({ status: 'failed', currentStepIndex: 0, rowVersion: 2 });
    // The item view prefills the capture form from the version's fields.
    expect(failed.fields.map((f) => f.key)).toEqual(['title', 'reference', 'qty']);

    const edited = (await admin.post(dataPath(failed.id), { rowVersion: failed.rowVersion, data: { title: 'new laptop', reference: 'PO-7781', qty: 2 } }).expect(200)).body as ItemDetailResponse;
    expect(edited).toMatchObject({ status: 'failed', currentStepIndex: 0, rowVersion: 3, data: { title: 'new laptop', reference: 'PO-7781', qty: 2 } });
    expect((await events(failed.id)).at(-1)).toEqual({ seq: 4, type: 'data_edited', actorSubject: sub('admin'), payload: { fields: ['reference'] } });

    const retried = (await admin.post(stepPath(failed.id, 'need', 'retry'), { rowVersion: edited.rowVersion }).expect(200)).body as ItemDetailResponse;
    expect(retried).toMatchObject({ status: 'in_progress', currentStepIndex: 1 });
    const reviewed = (await member.post(stepPath(failed.id, 'review', 'complete'), { rowVersion: retried.rowVersion }).expect(200)).body as ItemDetailResponse;
    expect(reviewed).toMatchObject({ status: 'in_progress', currentStepIndex: 2 });
    const done = (await admin.post(stepPath(failed.id, 'approve', 'complete'), { rowVersion: reviewed.rowVersion }).expect(200)).body as ItemDetailResponse;
    expect(done).toMatchObject({ status: 'completed', data: { title: 'new laptop', reference: 'PO-7781', qty: 2 } });
    expect((await events(failed.id)).map((e) => e.type)).toEqual([
      'captured', 'step_started', 'step_failed', 'data_edited', 'step_started', 'step_completed',
      'step_started', 'step_completed', 'step_started', 'step_completed', 'completed',
    ]);
  });

  it('an item waiting at a human step can be edited and the step is still waiting: its completion succeeds', async () => {
    const waiting = await capture(await workType({ fields, outputs, steps: [review] }), { title: 'desk' });
    expect(waiting).toMatchObject({ status: 'in_progress', currentStepIndex: 0 });
    const edited = (await admin.post(dataPath(waiting.id), { rowVersion: waiting.rowVersion, data: { title: 'standing desk', qty: 1 } }).expect(200)).body as ItemDetailResponse;
    expect(edited).toMatchObject({ status: 'in_progress', currentStepIndex: 0, rowVersion: waiting.rowVersion + 1 });
    expect((await events(waiting.id)).at(-1)).toMatchObject({ type: 'data_edited', payload: { fields: ['qty', 'title'] } });
    // A resume still sees the item waiting at the step, and the member completes it.
    expect((await admin.post(`/api/v1/teams/${teamId}/items/${waiting.id}/advance`, { rowVersion: edited.rowVersion }).expect(409)).body.message).toMatch(/waiting at step "Review"/);
    const done = (await member.post(stepPath(waiting.id, 'review', 'complete'), { rowVersion: edited.rowVersion }).expect(200)).body as ItemDetailResponse;
    expect(done).toMatchObject({ status: 'completed', data: { title: 'standing desk', qty: 1 } });
  });

  it('invalid data is 422 `{ errors }` keyed by field, and nothing is written', async () => {
    const failed = await capture(await workType({ fields, outputs, steps: [need] }), { title: 'lamp' });
    const before = await events(failed.id);
    const res = await admin.post(dataPath(failed.id), { rowVersion: failed.rowVersion, data: { reference: 'R-1', qty: 0, colour: 'red' } }).expect(422);
    expect(res.body.errors).toEqual({ title: [expect.any(String)], qty: [expect.any(String)], colour: ['Unknown field'] });
    expect(await events(failed.id)).toEqual(before);
    expect(await row(failed.id)).toMatchObject({ rowVersion: failed.rowVersion, data: { title: 'lamp' } });
  });

  it('a member gets 403 and an outsider 403; neither changes the item', async () => {
    const failed = await capture(await workType({ fields, outputs, steps: [need] }), { title: 'chair' });
    const body = { rowVersion: failed.rowVersion, data: { title: 'chair', reference: 'R-2' } };
    await member.post(dataPath(failed.id), body).expect(403);
    await outsider.post(dataPath(failed.id), body).expect(403);
    expect(await row(failed.id)).toMatchObject({ rowVersion: failed.rowVersion, data: { title: 'chair' } });
    expect(await events(failed.id)).toHaveLength(failed.events.length);
  });

  it('a stale rowVersion is 409, a missing one 400, an unknown item 404; none writes an event', async () => {
    const failed = await capture(await workType({ fields, outputs, steps: [need] }), { title: 'mouse' });
    const data = { title: 'mouse', reference: 'R-3' };
    expect((await admin.post(dataPath(failed.id), { rowVersion: failed.rowVersion - 1, data }).expect(409)).body.message).toMatch(/changed since it was read/);
    await admin.post(dataPath(failed.id), { data }).expect(400);
    await admin.post(dataPath(randomUUID()), { rowVersion: 0, data }).expect(404);
    // A replay of an applied edit is stale too.
    await admin.post(dataPath(failed.id), { rowVersion: failed.rowVersion, data }).expect(200);
    await admin.post(dataPath(failed.id), { rowVersion: failed.rowVersion, data: { title: 'mouse', reference: 'R-4' } }).expect(409);
    expect((await events(failed.id)).filter((e) => e.type === 'data_edited')).toHaveLength(1);
    expect(await row(failed.id)).toMatchObject({ rowVersion: failed.rowVersion + 1, data });
  });

  it('a `completed` item is 409 and keeps its data', async () => {
    const done = await capture(await workType({ fields, outputs, steps: [] }), { title: 'nothing to do' });
    expect(done.status).toBe('completed');
    expect((await admin.post(dataPath(done.id), { rowVersion: done.rowVersion, data: { title: 'changed' } }).expect(409)).body.message).toMatch(/completed/);
    expect(await row(done.id)).toMatchObject({ rowVersion: done.rowVersion, data: { title: 'nothing to do' } });
    expect(await events(done.id)).toHaveLength(done.events.length);
  });

  it('no data_edited payload contains a captured value', async () => {
    const failed = await capture(await workType({ fields, outputs, steps: [need] }), { title: 'secret-title-value' });
    await admin.post(dataPath(failed.id), { rowVersion: failed.rowVersion, data: { title: 'other-secret-value', reference: 'secret-reference-value', qty: 9137 } }).expect(200);
    const edits = (await events(failed.id)).filter((e) => e.type === 'data_edited');
    expect(edits).toEqual([expect.objectContaining({ payload: { fields: ['qty', 'reference', 'title'] } })]);
    const written = JSON.stringify(edits);
    for (const value of ['secret-title-value', 'other-secret-value', 'secret-reference-value', '9137']) expect(written).not.toContain(value);
  });
});

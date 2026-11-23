import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ItemDetailResponse, WorkTypeDefinition } from '@getworkdone/contracts';
import { createPrismaClient } from '@getworkdone/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { signIn, type SignedIn } from './support/identity.js';
import { fakeWebDist } from './support/web-dist.js';

// An admin cancels an item (GWP#54, docs/process.md "Cancel"), through the real routes and Postgres:
// POST .../items/:itemId/cancel moves an `open`, `in_progress` or `failed` item to `cancelled` in one
// guarded transition with one `cancelled` event. No output fires and the data is kept; afterwards every
// other write on the item is 409.
const run = randomUUID().slice(0, 8);
const sub = (name: string) => `cancel-${name}-${run}`;

const fields: WorkTypeDefinition['fields'] = [
  { key: 'title', label: 'Title', type: 'text', required: true },
  { key: 'reference', label: 'Reference', type: 'text', required: false },
];
const persist: WorkTypeDefinition['outputs'] = [{ id: 'keep', kind: 'persist', config: {} }];
const need = { id: 'need', name: 'Needs a reference', kind: 'automated', transform: 'require_fields', params: { fields: ['reference'] } } as const;
const review = { id: 'review', name: 'Review', kind: 'human', assigneeRole: 'member' } as const;

describe('cancelling an item', () => {
  let app: INestApplication;
  const db = createPrismaClient();
  const spans = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
  let admin: SignedIn;
  let member: SignedIn;
  let outsider: SignedIn;
  let teamId: string;
  let slugs = 0;

  async function workType(definition: WorkTypeDefinition): Promise<{ id: string; versionId: string }> {
    slugs += 1;
    const body = (await admin.post(`/api/v1/teams/${teamId}/work-types`, { slug: `wt-${slugs}`, definition }).expect(201)).body as { id: string; version: { id: string } };
    return { id: body.id, versionId: body.version.id };
  }

  async function capture(workTypeId: string, data: Record<string, unknown>): Promise<ItemDetailResponse> {
    return (await member.post(`/api/v1/teams/${teamId}/work-types/${workTypeId}/items`, { data }).expect(201)).body as ItemDetailResponse;
  }

  const itemPath = (itemId: string) => `/api/v1/teams/${teamId}/items/${itemId}`;
  const cancelPath = (itemId: string) => `${itemPath(itemId)}/cancel`;
  const events = async (itemId: string) => (await db.itemEvent.findMany({ where: { itemId }, orderBy: { seq: 'asc' } })).map((e) => ({ seq: e.seq, type: e.type, actorSubject: e.actorSubject, payload: e.payload }));
  const row = (itemId: string) => db.item.findUniqueOrThrow({ where: { id: itemId } });

  beforeAll(async () => {
    trace.setGlobalTracerProvider(provider);
    app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
    admin = await signIn(app, sub('admin'));
    member = await signIn(app, sub('member'));
    outsider = await signIn(app, sub('outsider'));
    teamId = (await admin.post('/api/v1/teams', { name: 'Cancel' }).expect(201)).body.id;
    await admin.post(`/api/v1/teams/${teamId}/members`, { subject: sub('member'), role: 'member' }).expect(201);
  });
  beforeEach(() => spans.reset());
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await provider.shutdown();
    trace.disable();
  });

  it('an item waiting at a human step is cancelled by an admin: 200 `cancelled`, one `cancelled` event with the reason and the admin, in a process.step span', async () => {
    const waiting = await capture((await workType({ fields, outputs: persist, steps: [review] })).id, { title: 'desk' });
    expect(waiting).toMatchObject({ status: 'in_progress', currentStepIndex: 0 });
    const before = await events(waiting.id);
    const res = await admin.post(cancelPath(waiting.id), { rowVersion: waiting.rowVersion, reason: 'captured twice' }).expect(200);
    const cancelled = res.body as ItemDetailResponse;
    expect(cancelled).toMatchObject({ status: 'cancelled', currentStepIndex: 0, rowVersion: waiting.rowVersion + 1, data: { title: 'desk' } });
    expect(cancelled.events.at(-1)).toMatchObject({ type: 'cancelled', actorSubject: sub('admin'), payload: { reason: 'captured twice' } });
    expect(await events(waiting.id)).toEqual([...before, { seq: before.length + 1, type: 'cancelled', actorSubject: sub('admin'), payload: { reason: 'captured twice' } }]);
    const span = spans.getFinishedSpans().find((s) => s.name === 'process.step' && s.attributes['process.transition'] === 'cancelled');
    expect(span?.attributes).toMatchObject({ 'step.id': 'review', 'step.kind': 'human' });
  });

  it('an `open` item (its processing stopped after capture) is cancelled; without a reason the payload is empty', async () => {
    const { versionId } = await workType({ fields, outputs: persist, steps: [review] });
    const item = await db.item.create({ data: { teamId, workTypeVersionId: versionId, data: { title: 'stuck' } } });
    await db.itemEvent.create({ data: { itemId: item.id, seq: 1, type: 'captured', actorSubject: sub('member'), payload: { workTypeVersionId: versionId } } });
    const cancelled = (await admin.post(cancelPath(item.id), { rowVersion: 0 }).expect(200)).body as ItemDetailResponse;
    expect(cancelled).toMatchObject({ status: 'cancelled', rowVersion: 1 });
    expect(await events(item.id)).toEqual([expect.objectContaining({ type: 'captured' }), { seq: 2, type: 'cancelled', actorSubject: sub('admin'), payload: {} }]);
  });

  it('a `failed` item is cancelled', async () => {
    const failed = await capture((await workType({ fields, outputs: persist, steps: [need] })).id, { title: 'lamp' });
    expect(failed.status).toBe('failed');
    const cancelled = (await admin.post(cancelPath(failed.id), { rowVersion: failed.rowVersion, reason: 'not needed' }).expect(200)).body as ItemDetailResponse;
    expect(cancelled).toMatchObject({ status: 'cancelled', rowVersion: failed.rowVersion + 1 });
    expect((await events(failed.id)).at(-1)).toEqual({ seq: failed.events.length + 1, type: 'cancelled', actorSubject: sub('admin'), payload: { reason: 'not needed' } });
  });

  it('a member is 403 and an outsider 403; the item is unchanged', async () => {
    const waiting = await capture((await workType({ fields, outputs: persist, steps: [review] })).id, { title: 'chair' });
    await member.post(cancelPath(waiting.id), { rowVersion: waiting.rowVersion }).expect(403);
    await outsider.post(cancelPath(waiting.id), { rowVersion: waiting.rowVersion }).expect(403);
    expect(await row(waiting.id)).toMatchObject({ status: 'in_progress', rowVersion: waiting.rowVersion });
    expect(await events(waiting.id)).toHaveLength(waiting.events.length);
  });

  it('a `completed` item is 409 naming its status and writes no event; a cancelled one is 409 too', async () => {
    const done = await capture((await workType({ fields, outputs: persist, steps: [] })).id, { title: 'nothing to do' });
    expect(done.status).toBe('completed');
    expect((await admin.post(cancelPath(done.id), { rowVersion: done.rowVersion }).expect(409)).body.message).toBe('This item is already completed');
    expect(await events(done.id)).toHaveLength(done.events.length);
    expect(await row(done.id)).toMatchObject({ status: 'completed', rowVersion: done.rowVersion });

    const waiting = await capture((await workType({ fields, outputs: persist, steps: [review] })).id, { title: 'twice' });
    const cancelled = (await admin.post(cancelPath(waiting.id), { rowVersion: waiting.rowVersion }).expect(200)).body as ItemDetailResponse;
    expect((await admin.post(cancelPath(waiting.id), { rowVersion: cancelled.rowVersion }).expect(409)).body.message).toBe('This item is already cancelled');
    expect((await events(waiting.id)).filter((e) => e.type === 'cancelled')).toHaveLength(1);
  });

  it('a stale rowVersion is 409, a bad body 400, an unknown item 404; none writes an event', async () => {
    const waiting = await capture((await workType({ fields, outputs: persist, steps: [review] })).id, { title: 'mouse' });
    expect((await admin.post(cancelPath(waiting.id), { rowVersion: waiting.rowVersion - 1 }).expect(409)).body.message).toMatch(/changed since it was read/);
    await admin.post(cancelPath(waiting.id), {}).expect(400);
    await admin.post(cancelPath(waiting.id), { rowVersion: waiting.rowVersion, reason: 'x'.repeat(2001) }).expect(400);
    await admin.post(cancelPath(waiting.id), { rowVersion: waiting.rowVersion, other: 1 }).expect(400);
    await admin.post(cancelPath(randomUUID()), { rowVersion: 0 }).expect(404);
    expect(await events(waiting.id)).toHaveLength(waiting.events.length);
    expect(await row(waiting.id)).toMatchObject({ status: 'in_progress', rowVersion: waiting.rowVersion });
  });

  it('after a cancel, complete, retry, advance and a data edit are each 409 `This item is already cancelled` and write nothing', async () => {
    const waiting = await capture((await workType({ fields, outputs: persist, steps: [review] })).id, { title: 'waiting' });
    const failed = await capture((await workType({ fields, outputs: persist, steps: [need] })).id, { title: 'failed' });
    const a = (await admin.post(cancelPath(waiting.id), { rowVersion: waiting.rowVersion }).expect(200)).body as ItemDetailResponse;
    const b = (await admin.post(cancelPath(failed.id), { rowVersion: failed.rowVersion }).expect(200)).body as ItemDetailResponse;
    const countA = (await events(waiting.id)).length;
    const countB = (await events(failed.id)).length;
    const refusals = [
      () => member.post(`${itemPath(waiting.id)}/steps/review/complete`, { rowVersion: a.rowVersion }),
      () => admin.post(`${itemPath(waiting.id)}/steps/review/complete`, { rowVersion: a.rowVersion }),
      () => admin.post(`${itemPath(failed.id)}/steps/need/retry`, { rowVersion: b.rowVersion }),
      () => admin.post(`${itemPath(waiting.id)}/advance`, { rowVersion: a.rowVersion }),
      () => admin.post(`${itemPath(waiting.id)}/data`, { rowVersion: a.rowVersion, data: { title: 'changed' } }),
      () => admin.post(`${itemPath(failed.id)}/data`, { rowVersion: b.rowVersion, data: { title: 'failed', reference: 'R-1' } }),
    ];
    for (const send of refusals) expect((await send().expect(409)).body.message).toBe('This item is already cancelled');
    expect(await events(waiting.id)).toHaveLength(countA);
    expect(await events(failed.id)).toHaveLength(countB);
    expect(await row(waiting.id)).toMatchObject({ status: 'cancelled', rowVersion: a.rowVersion, data: { title: 'waiting' } });
    expect(await row(failed.id)).toMatchObject({ status: 'cancelled', rowVersion: b.rowVersion, data: { title: 'failed' } });
    // The item reads back cancelled with the cancel as its last event.
    const read = (await member.get(itemPath(waiting.id)).expect(200)).body as ItemDetailResponse;
    expect(read).toMatchObject({ status: 'cancelled' });
    expect(read.events.at(-1)?.type).toBe('cancelled');
  });

  it('no output fires: the data of an output-`none` item is kept, and an email output writes no Delivery row', async () => {
    const none = await capture((await workType({ fields, outputs: [{ id: 'drop', kind: 'none', config: {} }], steps: [review] })).id, { title: 'keep me', reference: 'R-9' });
    const cancelled = (await admin.post(cancelPath(none.id), { rowVersion: none.rowVersion }).expect(200)).body as ItemDetailResponse;
    expect(cancelled.data).toEqual({ title: 'keep me', reference: 'R-9' });
    expect((await row(none.id)).data).toEqual({ title: 'keep me', reference: 'R-9' });
    expect((await events(none.id)).some((e) => e.type === 'completed')).toBe(false);

    const mailed = await capture((await workType({ fields, outputs: [{ id: 'mail', kind: 'email', config: { recipients: ['ops@example.com'] } }], steps: [review] })).id, { title: 'mail me' });
    await admin.post(cancelPath(mailed.id), { rowVersion: mailed.rowVersion }).expect(200);
    expect(await db.delivery.count({ where: { itemId: { in: [none.id, mailed.id] } } })).toBe(0);
  });
});

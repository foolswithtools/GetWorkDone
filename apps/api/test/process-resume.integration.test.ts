import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { ItemDetailResponse, WorkTypeDefinition } from '@getworkdone/contracts';
import { createPrismaClient } from '@getworkdone/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { ProcessService } from '../src/modules/process/process.service.js';
import { signIn, type SignedIn } from './support/identity.js';
import { fakeWebDist } from './support/web-dist.js';

// Resuming an item whose processing stopped between two transitions (GWP#22, docs/process.md "Resume"),
// through the real routes and Postgres. The request is stopped by letting a number of transitions
// commit and failing the next, as a process exit or a dropped connection would; `POST .../advance`
// then leaves the item where one uninterrupted request would have, with no gap in its events' seq.
const run = randomUUID().slice(0, 8);
const sub = (name: string) => `resume-${name}-${run}`;

const fields: WorkTypeDefinition['fields'] = [
  { key: 'title', label: 'Title', type: 'text', required: true },
  { key: 'reference', label: 'Reference', type: 'text', required: false },
  { key: 'urgent', label: 'Urgent', type: 'boolean', required: false },
];
const outputs: WorkTypeDefinition['outputs'] = [{ id: 'keep', kind: 'persist', config: {} }];
const upper = { id: 'upper', name: 'Upper-case the title', kind: 'automated', transform: 'string_case', params: { field: 'title', op: 'upper' } } as const;
const flag = { id: 'flag', name: 'Flag urgent', kind: 'automated', transform: 'set_field', params: { field: 'urgent', value: true } } as const;
const review = { id: 'review', name: 'Review', kind: 'human', assigneeRole: 'member' } as const;

describe('process resume', () => {
  let app: INestApplication;
  let processService: ProcessService;
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

  /** Lets `commits` transitions commit, then fails the next one, as if the request had ended there. */
  function stopAfter(commits: number) {
    const target = processService as unknown as { transition: (...args: unknown[]) => Promise<void> };
    const original = target.transition.bind(processService);
    let left = commits;
    return vi.spyOn(target, 'transition').mockImplementation(async (...args: unknown[]) => {
      if (left === 0) throw new Error('connection terminated');
      left -= 1;
      return original(...args);
    });
  }

  const advancePath = (itemId: string) => `/api/v1/teams/${teamId}/items/${itemId}/advance`;
  const events = async (itemId: string) => (await db.itemEvent.findMany({ where: { itemId }, orderBy: { seq: 'asc' } })).map((e) => ({ seq: e.seq, type: e.type, actorSubject: e.actorSubject, payload: e.payload }));
  const row = (itemId: string) => db.item.findUniqueOrThrow({ where: { id: itemId } });

  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
    processService = app.get(ProcessService);
    admin = await signIn(app, sub('admin'));
    member = await signIn(app, sub('member'));
    outsider = await signIn(app, sub('outsider'));
    teamId = (await admin.post('/api/v1/teams', { name: 'Resume' }).expect(201)).body.id;
    await db.teamMember.create({ data: { teamId, subject: sub('member'), role: 'member' } });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('an item left `open` after capture (no step_started) is advanced to its first human step by POST .../advance', async () => {
    const wt = await workType({ fields, outputs, steps: [upper, review, flag] });
    stopAfter(0);
    // The capture answers 201 with the item as it stands, so the submitter does not capture it again.
    const stuck = await capture(wt, { title: 'new laptop' });
    expect(stuck).toMatchObject({ status: 'open', currentStepIndex: 0, rowVersion: 0, data: { title: 'new laptop' } });
    expect(stuck.steps.map((s) => s.id)).toEqual(['upper', 'review', 'flag']);
    vi.restoreAllMocks();

    const res = await admin.post(advancePath(stuck.id), { rowVersion: stuck.rowVersion }).expect(200);
    // Where an uninterrupted capture leaves this work type's item (process.integration.test.ts).
    expect(res.body).toMatchObject({ status: 'in_progress', currentStepIndex: 1, rowVersion: 3, data: { title: 'NEW LAPTOP' } });
    expect(await events(stuck.id)).toEqual([
      expect.objectContaining({ seq: 1, type: 'captured', actorSubject: sub('member') }),
      { seq: 2, type: 'step_started', actorSubject: null, payload: { stepId: 'upper', stepIndex: 0, kind: 'automated', transform: 'string_case' } },
      { seq: 3, type: 'step_completed', actorSubject: null, payload: { stepId: 'upper', stepIndex: 0, kind: 'automated', transform: 'string_case' } },
      { seq: 4, type: 'step_started', actorSubject: sub('admin'), payload: { stepId: 'review', stepIndex: 1, kind: 'human', assigneeRole: 'member' } },
    ]);
  });

  it('a member gets 403, an outsider 403, and neither changes the item', async () => {
    stopAfter(0);
    const stuck = await capture(await workType({ fields, outputs, steps: [upper, review] }), { title: 'desk' });
    vi.restoreAllMocks();
    await member.post(advancePath(stuck.id), { rowVersion: stuck.rowVersion }).expect(403);
    await outsider.post(advancePath(stuck.id), { rowVersion: stuck.rowVersion }).expect(403);
    expect(await row(stuck.id)).toMatchObject({ status: 'open', rowVersion: 0 });
    expect(await events(stuck.id)).toHaveLength(1);
  });

  it('a stale rowVersion is 409, a missing one 400, and an unknown item 404; none writes an event', async () => {
    stopAfter(1);
    const stuck = await capture(await workType({ fields, outputs, steps: [upper, review] }), { title: 'lamp' });
    vi.restoreAllMocks();
    expect(stuck).toMatchObject({ status: 'in_progress', rowVersion: 1 });
    const stale = await admin.post(advancePath(stuck.id), { rowVersion: 0 }).expect(409);
    expect(stale.body.message).toMatch(/changed since it was read/);
    await admin.post(advancePath(stuck.id), {}).expect(400);
    await admin.post(advancePath(randomUUID()), { rowVersion: 0 }).expect(404);
    expect(await row(stuck.id)).toMatchObject({ status: 'in_progress', rowVersion: 1 });
    expect(await events(stuck.id)).toHaveLength(2);
  });

  it('an item waiting at a human step is 409, says so, and is unchanged', async () => {
    const waiting = await capture(await workType({ fields, outputs, steps: [upper, review] }), { title: 'chair' });
    expect(waiting).toMatchObject({ status: 'in_progress', currentStepIndex: 1 });
    const before = await events(waiting.id);
    const res = await admin.post(advancePath(waiting.id), { rowVersion: waiting.rowVersion }).expect(409);
    expect(res.body.message).toMatch(/waiting at step "Review"/);
    expect(await events(waiting.id)).toEqual(before);
    expect(await row(waiting.id)).toMatchObject({ rowVersion: waiting.rowVersion });
  });

  it('a failed or completed item is 409 with a message saying which, and writes no event', async () => {
    const need = { id: 'need', name: 'Need a reference', kind: 'automated', transform: 'require_fields', params: { fields: ['reference'] } } as const;
    const failed = await capture(await workType({ fields, outputs, steps: [need] }), { title: 'no reference' });
    expect(failed.status).toBe('failed');
    const refused = await admin.post(advancePath(failed.id), { rowVersion: failed.rowVersion }).expect(409);
    expect(refused.body.message).toMatch(/failed/);
    expect(await events(failed.id)).toHaveLength(failed.events.length);

    const done = await capture(await workType({ fields, outputs, steps: [] }), { title: 'nothing to do' });
    expect(done.status).toBe('completed');
    expect((await admin.post(advancePath(done.id), { rowVersion: done.rowVersion }).expect(409)).body.message).toMatch(/completed/);
    expect(await events(done.id)).toHaveLength(done.events.length);
  });

  // Every place a request can stop on a type with two automated steps, a human step and an end.
  for (const commits of [1, 2, 3, 4]) {
    it(`a request stopped after ${commits} transition(s) resumes to the human step with no gap in seq`, async () => {
      const wt = await workType({ fields, outputs, steps: [upper, flag, review] });
      const uninterrupted = await capture(wt, { title: 'mouse' });
      stopAfter(commits);
      const stuck = await capture(wt, { title: 'mouse' });
      vi.restoreAllMocks();
      expect(stuck).toMatchObject({ status: 'in_progress', rowVersion: commits });

      const res = (await admin.post(advancePath(stuck.id), { rowVersion: stuck.rowVersion }).expect(200)).body as ItemDetailResponse;
      expect(res).toMatchObject({ status: uninterrupted.status, currentStepIndex: uninterrupted.currentStepIndex, rowVersion: uninterrupted.rowVersion, data: uninterrupted.data });
      const resumed = await events(stuck.id);
      expect(resumed.map((e) => e.seq)).toEqual(resumed.map((_, i) => i + 1));
      expect(resumed.map((e) => [e.type, e.payload])).toEqual((await events(uninterrupted.id)).map((e) => [e.type, e.payload]));
    });
  }

  it('a request stopped before the `completed` transition resumes to completed and fires onItemCompleted once', async () => {
    const wt = await workType({ fields, outputs, steps: [upper] });
    stopAfter(2);
    const stuck = await capture(wt, { title: 'pen' });
    vi.restoreAllMocks();
    expect(stuck).toMatchObject({ status: 'in_progress', currentStepIndex: 1 });
    const hook = vi.spyOn(processService, 'onItemCompleted');
    const res = await admin.post(advancePath(stuck.id), { rowVersion: stuck.rowVersion }).expect(200);
    expect(res.body).toMatchObject({ status: 'completed', currentStepIndex: 1, data: { title: 'PEN' } });
    expect((await events(stuck.id)).map((e) => [e.seq, e.type, e.actorSubject])).toEqual([
      [1, 'captured', sub('member')], [2, 'step_started', null], [3, 'step_completed', null], [4, 'completed', sub('admin')],
    ]);
    expect(hook).toHaveBeenCalledTimes(1);
  });
});

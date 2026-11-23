import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { ItemDetailResponse, WorkTypeDefinition } from '@getworkdone/contracts';
import { createPrismaClient } from '@getworkdone/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { ProcessService } from '../src/modules/process/process.service.js';
import { signIn, type SignedIn } from './support/identity.js';
import { fakeWebDist } from './support/web-dist.js';

// Processing through the real routes and Postgres (GWP#5, docs/process.md): capture runs automated
// steps until a human step, a member completes it, the item ends `completed`. Every transition is one
// guarded UPDATE plus one ItemEvent, so stale, replayed and concurrent completions change nothing.
const run = randomUUID().slice(0, 8);
const sub = (name: string) => `process-${name}-${run}`;

const fields: WorkTypeDefinition['fields'] = [
  { key: 'title', label: 'Title', type: 'text', required: true },
  { key: 'reference', label: 'Reference', type: 'text', required: false },
  { key: 'urgent', label: 'Urgent', type: 'boolean', required: false },
];
const outputs: WorkTypeDefinition['outputs'] = [{ id: 'keep', kind: 'persist', config: {} }];

/** automated, human (`role`), automated: upper-case the title, a review, then flag the item urgent. */
function threeSteps(role: 'member' | 'admin' = 'member'): WorkTypeDefinition {
  return {
    fields, outputs,
    steps: [
      { id: 'upper', name: 'Upper-case the title', kind: 'automated', transform: 'string_case', params: { field: 'title', op: 'upper' } },
      { id: 'review', name: 'Review', kind: 'human', assigneeRole: role },
      { id: 'flag', name: 'Flag urgent', kind: 'automated', transform: 'set_field', params: { field: 'urgent', value: true } },
    ],
  };
}

describe('process', () => {
  let app: INestApplication;
  const db = createPrismaClient();
  const spans = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
  let admin: SignedIn;
  let member: SignedIn;
  let outsider: SignedIn;
  let teamId: string;
  let slugs = 0;

  /** A new work type in the team with `definition`; returns its id. */
  async function workType(definition: WorkTypeDefinition): Promise<string> {
    slugs += 1;
    return (await admin.post(`/api/v1/teams/${teamId}/work-types`, { slug: `wt-${slugs}`, definition }).expect(201)).body.id as string;
  }

  async function capture(workTypeId: string, data: Record<string, unknown>, who: SignedIn = member): Promise<ItemDetailResponse> {
    return (await who.post(`/api/v1/teams/${teamId}/work-types/${workTypeId}/items`, { data }).expect(201)).body as ItemDetailResponse;
  }

  const stepPath = (itemId: string, stepId: string, action: 'complete' | 'retry') => `/api/v1/teams/${teamId}/items/${itemId}/steps/${encodeURIComponent(stepId)}/${action}`;
  const events = async (itemId: string) => (await db.itemEvent.findMany({ where: { itemId }, orderBy: { seq: 'asc' } })).map((e) => ({ seq: e.seq, type: e.type, actorSubject: e.actorSubject, payload: e.payload }));

  beforeAll(async () => {
    trace.setGlobalTracerProvider(provider);
    app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
    admin = await signIn(app, sub('admin'));
    member = await signIn(app, sub('member'));
    outsider = await signIn(app, sub('outsider'));
    teamId = (await admin.post('/api/v1/teams', { name: 'Process' }).expect(201)).body.id;
    await db.teamMember.create({ data: { teamId, subject: sub('member'), role: 'member' } });
  });
  beforeEach(() => spans.reset());
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await provider.shutdown();
    trace.disable();
  });

  it('automated, human, automated: capture runs the first step and stops at the human step', async () => {
    const item = await capture(await workType(threeSteps()), { title: 'new laptop' });
    expect(item).toMatchObject({ status: 'in_progress', currentStepIndex: 1, rowVersion: 3, data: { title: 'NEW LAPTOP' } });
    expect(item.steps.map((s) => s.id)).toEqual(['upper', 'review', 'flag']);
    expect(await events(item.id)).toEqual([
      expect.objectContaining({ seq: 1, type: 'captured', actorSubject: sub('member') }),
      { seq: 2, type: 'step_started', actorSubject: null, payload: { stepId: 'upper', stepIndex: 0, kind: 'automated', transform: 'string_case' } },
      { seq: 3, type: 'step_completed', actorSubject: null, payload: { stepId: 'upper', stepIndex: 0, kind: 'automated', transform: 'string_case' } },
      { seq: 4, type: 'step_started', actorSubject: sub('member'), payload: { stepId: 'review', stepIndex: 1, kind: 'human', assigneeRole: 'member' } },
    ]);
    const steps = spans.getFinishedSpans().filter((s) => s.name === 'process.step');
    expect(steps.map((s) => s.attributes)).toEqual([
      { 'process.transition': 'step_started', 'step.kind': 'automated', 'step.id': 'upper', 'transform.name': 'string_case' },
      { 'process.transition': 'step_completed', 'step.kind': 'automated', 'step.id': 'upper', 'transform.name': 'string_case' },
      { 'process.transition': 'step_started', 'step.kind': 'human', 'step.id': 'review' },
    ]);
    // The item view reads the same state.
    const read = await member.get(`/api/v1/teams/${teamId}/items/${item.id}`).expect(200);
    expect(read.body).toMatchObject({ status: 'in_progress', currentStepIndex: 1, steps: item.steps });
  });

  it('completing the human step runs the rest, ends `completed` and fires onItemCompleted once', async () => {
    const hook = vi.spyOn(app.get(ProcessService), 'onItemCompleted');
    const item = await capture(await workType(threeSteps()), { title: 'chair' });
    const res = await member.post(stepPath(item.id, 'review', 'complete'), { rowVersion: item.rowVersion }).expect(200);
    expect(res.body).toMatchObject({ status: 'completed', currentStepIndex: 3, data: { title: 'CHAIR', urgent: true } });
    expect((await events(item.id)).slice(4)).toEqual([
      { seq: 5, type: 'step_completed', actorSubject: sub('member'), payload: { stepId: 'review', stepIndex: 1, kind: 'human' } },
      { seq: 6, type: 'step_started', actorSubject: null, payload: { stepId: 'flag', stepIndex: 2, kind: 'automated', transform: 'set_field' } },
      { seq: 7, type: 'step_completed', actorSubject: null, payload: { stepId: 'flag', stepIndex: 2, kind: 'automated', transform: 'set_field' } },
      { seq: 8, type: 'completed', actorSubject: sub('member'), payload: {} },
    ]);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ id: item.id, status: 'completed' }));
    const completed = spans.getFinishedSpans().filter((s) => s.name === 'process.step').at(-1);
    expect(completed?.attributes).toEqual({ 'process.transition': 'completed' });
    hook.mockRestore();
  });

  it('a work type with no steps is completed as soon as it is captured', async () => {
    const item = await capture(await workType({ fields, outputs, steps: [] }), { title: 'nothing to do' });
    expect(item.status).toBe('completed');
    expect((await events(item.id)).map((e) => e.type)).toEqual(['captured', 'completed']);
  });

  it('completion by a wrong role is 403 and changes nothing; an admin may complete a member step', async () => {
    const adminStep = await capture(await workType(threeSteps('admin')), { title: 'desk' });
    await member.post(stepPath(adminStep.id, 'review', 'complete'), { rowVersion: adminStep.rowVersion }).expect(403);
    expect(await db.item.findUnique({ where: { id: adminStep.id } })).toMatchObject({ status: 'in_progress', rowVersion: adminStep.rowVersion });
    await admin.post(stepPath(adminStep.id, 'review', 'complete'), { rowVersion: adminStep.rowVersion }).expect(200);

    const memberStep = await capture(await workType(threeSteps('member')), { title: 'lamp' });
    expect((await admin.post(stepPath(memberStep.id, 'review', 'complete'), { rowVersion: memberStep.rowVersion }).expect(200)).body.status).toBe('completed');
  });

  it('a replayed completion is 409 and leaves one step_completed event', async () => {
    const item = await capture(await workType(threeSteps()), { title: 'monitor' });
    await member.post(stepPath(item.id, 'review', 'complete'), { rowVersion: item.rowVersion }).expect(200);
    const after = await events(item.id);
    await member.post(stepPath(item.id, 'review', 'complete'), { rowVersion: item.rowVersion }).expect(409);
    const current = await db.item.findUniqueOrThrow({ where: { id: item.id } });
    // Even with the current rowVersion, the step is no longer waiting.
    await member.post(stepPath(item.id, 'review', 'complete'), { rowVersion: current.rowVersion }).expect(409);
    expect(await events(item.id)).toEqual(after);
    expect(after.filter((e) => e.type === 'step_completed' && (e.payload as { stepId: string }).stepId === 'review')).toHaveLength(1);
  });

  it('20 parallel completions of one step: exactly one 200, nineteen 409, one step_completed row', async () => {
    const item = await capture(await workType(threeSteps()), { title: 'race' });
    const statuses = await Promise.all(Array.from({ length: 20 }, async () => (await member.post(stepPath(item.id, 'review', 'complete'), { rowVersion: item.rowVersion })).status));
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(19);
    const all = await events(item.id);
    expect(all.filter((e) => e.type === 'step_completed' && (e.payload as { stepId: string }).stepId === 'review')).toHaveLength(1);
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    expect((await db.item.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('completed');
  });

  it('a stale rowVersion, a step that is not current, an unknown step and a bad body are refused', async () => {
    const item = await capture(await workType(threeSteps()), { title: 'stale' });
    await member.post(stepPath(item.id, 'review', 'complete'), { rowVersion: item.rowVersion - 1 }).expect(409);
    await member.post(stepPath(item.id, 'flag', 'complete'), { rowVersion: item.rowVersion }).expect(409);
    await member.post(stepPath(item.id, 'nope', 'complete'), { rowVersion: item.rowVersion }).expect(404);
    await member.post(stepPath(item.id, 'review', 'complete'), {}).expect(400);
    await outsider.post(stepPath(item.id, 'review', 'complete'), { rowVersion: item.rowVersion }).expect(403);
    const otherTeam = (await outsider.post('/api/v1/teams', { name: 'Other' }).expect(201)).body.id;
    await outsider.post(`/api/v1/teams/${otherTeam}/items/${item.id}/steps/review/complete`, { rowVersion: item.rowVersion }).expect(404);
    expect((await events(item.id)).map((e) => e.type)).toEqual(['captured', 'step_started', 'step_completed', 'step_started']);
  });

  it('a require_fields failure sets `failed`; an admin\'s retry re-runs the step once and succeeds after the field is set', async () => {
    const id = await workType({
      fields, outputs,
      steps: [
        { id: 'need', name: 'Needs a reference', kind: 'automated', transform: 'require_fields', params: { fields: ['title', 'reference'] } },
        { id: 'review', name: 'Review', kind: 'human', assigneeRole: 'member' },
      ],
    });
    const item = await capture(id, { title: 'no reference' });
    expect(item).toMatchObject({ status: 'failed', currentStepIndex: 0 });
    expect((await events(item.id)).at(-1)).toEqual({ seq: 3, type: 'step_failed', actorSubject: null, payload: { stepId: 'need', stepIndex: 0, kind: 'automated', transform: 'require_fields', reason: 'Required fields are empty: reference' } });

    // Members cannot retry; a retry of a step that is not the failed one is 409.
    await member.post(stepPath(item.id, 'need', 'retry'), { rowVersion: item.rowVersion }).expect(403);
    await admin.post(stepPath(item.id, 'review', 'retry'), { rowVersion: item.rowVersion }).expect(409);

    // Retried before the data changes: the step runs once more and fails again.
    const again = (await admin.post(stepPath(item.id, 'need', 'retry'), { rowVersion: item.rowVersion }).expect(200)).body as ItemDetailResponse;
    expect(again.status).toBe('failed');
    expect((await events(item.id)).slice(3).map((e) => [e.type, e.actorSubject, (e.payload as { retry?: boolean }).retry])).toEqual([['step_started', sub('admin'), true], ['step_failed', null, undefined]]);
    // A replay of that retry is stale.
    await admin.post(stepPath(item.id, 'need', 'retry'), { rowVersion: item.rowVersion }).expect(409);

    // An admin corrects the data (GWP#23, item-data.integration.test.ts), then the retry passes.
    const edited = (await admin.post(`/api/v1/teams/${teamId}/items/${item.id}/data`, { rowVersion: again.rowVersion, data: { title: 'no reference', reference: 'REF-1' } }).expect(200)).body as ItemDetailResponse;
    const fixed = (await admin.post(stepPath(item.id, 'need', 'retry'), { rowVersion: edited.rowVersion }).expect(200)).body as ItemDetailResponse;
    expect(fixed).toMatchObject({ status: 'in_progress', currentStepIndex: 1 });
    expect((await member.post(stepPath(item.id, 'review', 'complete'), { rowVersion: fixed.rowVersion }).expect(200)).body.status).toBe('completed');
  });

  it('a transform output that fails validateCapture marks the step failed with the errors', async () => {
    const id = await workType({
      fields: [...fields, { key: 'code', label: 'Code', type: 'text', required: false, max: 3 }], outputs,
      steps: [{ id: 'copy', name: 'Copy the title to the code', kind: 'automated', transform: 'copy_field', params: { from: 'title', to: 'code' } }],
    });
    const item = await capture(id, { title: 'too long' });
    expect(item.status).toBe('failed');
    expect((await events(item.id)).at(-1)?.payload).toMatchObject({ reason: 'The result does not pass the work type\'s validation', errors: { code: ['Must be at most 3 characters'] } });
  });

  it('an unknown transform name is refused at save with 422, on create and on a new version, and writes nothing', async () => {
    const bad: WorkTypeDefinition = { fields, outputs, steps: [{ id: 'x', name: 'X', kind: 'automated', transform: 'run_shell', params: {} }] };
    const created = await admin.post(`/api/v1/teams/${teamId}/work-types`, { slug: 'unknown-transform', definition: bad }).expect(422);
    expect(created.body).toEqual({ errors: { 'definition.steps.0.transform': ['Unknown transform "run_shell"'] } });
    expect(await db.workType.count({ where: { teamId, slug: 'unknown-transform' } })).toBe(0);

    const id = await workType(threeSteps());
    const revised = await admin.post(`/api/v1/teams/${teamId}/work-types/${id}/versions`, { definition: bad }).expect(422);
    expect(revised.body).toEqual({ errors: { 'definition.steps.0.transform': ['Unknown transform "run_shell"'] } });
    expect(await db.workTypeVersion.count({ where: { workTypeId: id } })).toBe(1);
  });

  // Regression (docs/known-issues/2026-10-21-step-ids-that-cannot-be-completed.md): a step id is a URL path
  // segment, and Express never routes `steps//complete`, while `.` and `..` are collapsed by URL
  // normalisation, so a human step with such an id could never be completed.
  it('a step id that cannot be a path segment is refused at save with 422, on create and on a new version', async () => {
    for (const stepId of ['', '.', '..']) {
      const bad: WorkTypeDefinition = { fields, outputs, steps: [{ id: stepId, name: 'Review', kind: 'human', assigneeRole: 'member' }] };
      const created = await admin.post(`/api/v1/teams/${teamId}/work-types`, { slug: 'bad-step-id', definition: bad }).expect(422);
      expect(created.body).toEqual({ errors: { 'definition.steps.0.id': ['Use 1 to 64 letters, digits, dashes and underscores'] } });
      expect(await db.workType.count({ where: { teamId, slug: 'bad-step-id' } })).toBe(0);
    }
    const id = await workType(threeSteps());
    await admin.post(`/api/v1/teams/${teamId}/work-types/${id}/versions`, { definition: { fields, outputs, steps: [{ id: '..', name: 'R', kind: 'human', assigneeRole: 'member' }] } }).expect(422);
    expect(await db.workTypeVersion.count({ where: { workTypeId: id } })).toBe(1);
  });

  // GWP#54: the person completing a human step records a decision and a comment on its event, never in the data.
  describe('a decision and a comment on a human step', () => {
    const approve: WorkTypeDefinition['steps'][number] = { id: 'approve', name: 'Approve', kind: 'human', assigneeRole: 'member', decisions: ['approve', 'reject'] };
    const note = { id: 'note', name: 'Note', kind: 'human', assigneeRole: 'member' } as const;
    const decide = (steps: WorkTypeDefinition['steps']) => ({ fields, outputs, steps });

    it('a decision from the step\'s list and a comment are written on step_completed; the data is unchanged', async () => {
      const item = await capture(await workType(decide([approve])), { title: 'laptop' });
      const done = (await member.post(stepPath(item.id, 'approve', 'complete'), { rowVersion: item.rowVersion, decision: 'approve', comment: 'ok' }).expect(200)).body as ItemDetailResponse;
      expect(done).toMatchObject({ status: 'completed', data: { title: 'laptop' } });
      const completed = (await events(item.id)).find((e) => e.type === 'step_completed');
      expect(completed).toEqual({ seq: 3, type: 'step_completed', actorSubject: sub('member'), payload: { stepId: 'approve', stepIndex: 0, kind: 'human', decision: 'approve', comment: 'ok' } });
      expect(done.events.find((e) => e.type === 'step_completed')?.payload).toMatchObject({ decision: 'approve', comment: 'ok' });
    });

    it('a decision not in the step\'s list, or none, is 422 keyed `decision` and writes nothing', async () => {
      const item = await capture(await workType(decide([approve])), { title: 'chair' });
      const before = await events(item.id);
      expect((await member.post(stepPath(item.id, 'approve', 'complete'), { rowVersion: item.rowVersion, decision: 'maybe' }).expect(422)).body.errors).toEqual({ decision: ['Choose one of: approve, reject'] });
      expect((await member.post(stepPath(item.id, 'approve', 'complete'), { rowVersion: item.rowVersion, comment: 'no decision' }).expect(422)).body.errors).toEqual({ decision: ['Choose one of: approve, reject'] });
      expect(await events(item.id)).toEqual(before);
      expect(await db.item.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ status: 'in_progress', rowVersion: item.rowVersion });
    });

    it('a step without decisions takes any decision text, or none; `{ rowVersion }` alone still completes it', async () => {
      const first = await capture(await workType(decide([note, note2()])), { title: 'desk' });
      const next = (await member.post(stepPath(first.id, 'note', 'complete'), { rowVersion: first.rowVersion, decision: 'looks fine to me' }).expect(200)).body as ItemDetailResponse;
      const done = (await member.post(stepPath(first.id, 'note2', 'complete'), { rowVersion: next.rowVersion }).expect(200)).body as ItemDetailResponse;
      expect(done.status).toBe('completed');
      const completions = (await events(first.id)).filter((e) => e.type === 'step_completed');
      expect(completions.map((e) => e.payload)).toEqual([
        { stepId: 'note', stepIndex: 0, kind: 'human', decision: 'looks fine to me' },
        { stepId: 'note2', stepIndex: 1, kind: 'human' },
      ]);
    });

    it('a decision over 40 characters, a comment over 2000 or an unknown key is 400', async () => {
      const item = await capture(await workType(decide([note])), { title: 'lamp' });
      for (const extra of [{ decision: 'x'.repeat(41) }, { comment: 'x'.repeat(2001) }, { reason: 'x' }]) {
        await member.post(stepPath(item.id, 'note', 'complete'), { rowVersion: item.rowVersion, ...extra }).expect(400);
      }
      expect(await events(item.id)).toHaveLength(item.events.length);
    });

    function note2() {
      return { ...note, id: 'note2', name: 'Second note' } as const;
    }
  });

  it('every completed item has an ItemEvent sequence with no gaps in seq', async () => {
    const items = await db.item.findMany({ where: { teamId, status: 'completed' }, include: { events: { orderBy: { seq: 'asc' } } } });
    expect(items.length).toBeGreaterThan(3);
    for (const item of items) {
      expect(item.events.map((e) => e.seq)).toEqual(item.events.map((_, i) => i + 1));
      expect(item.events.at(-1)?.type).toBe('completed');
    }
  });
});

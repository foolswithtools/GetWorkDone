import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { WorkTypeDefinition } from '@getworkdone/contracts';
import { createPrismaClient } from '@getworkdone/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { signIn, type SignedIn } from './support/identity.js';
import { fakeWebDist } from './support/web-dist.js';

// Subjects are unique per run, so a database kept from an earlier run does not add teams to them.
const run = randomUUID().slice(0, 8);
const sub = (name: string) => `capture-${name}-${run}`;

function definition(fields: WorkTypeDefinition['fields']): WorkTypeDefinition {
  return { fields, steps: [], outputs: [{ id: 'keep', kind: 'persist', config: {} }] };
}

const threeFields = definition([
  { key: 'title', label: 'Title', type: 'text', required: true, max: 40 },
  { key: 'amount', label: 'Amount', type: 'number', required: false, min: 0 },
  { key: 'contact', label: 'Contact', type: 'email', required: true },
]);

// Capture through the real routes (GWP#4): an admin writes versions, a member submits items, both
// validated by @getworkdone/contracts (capture.ts), and the submit runs inside the capture.submit span.
describe('capture', () => {
  let app: INestApplication;
  const db = createPrismaClient();
  const spans = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
  let admin: SignedIn;
  let member: SignedIn;
  let outsider: SignedIn;
  let teamId: string;
  let workType: { id: string; version: { id: string; version: number } };
  const base = () => `/api/v1/teams/${teamId}/work-types/${workType.id}`;

  beforeAll(async () => {
    trace.setGlobalTracerProvider(provider);
    app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
    admin = await signIn(app, sub('admin'));
    member = await signIn(app, sub('member'));
    outsider = await signIn(app, sub('outsider'));
    teamId = (await admin.post('/api/v1/teams', { name: 'Capture' }).expect(201)).body.id;
    await db.teamMember.create({ data: { teamId, subject: sub('member'), role: 'member' } });
    workType = (await admin.post(`/api/v1/teams/${teamId}/work-types`, { slug: 'requests', definition: threeFields }).expect(201)).body;
  });
  beforeEach(() => spans.reset());
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
    await provider.shutdown();
    trace.disable();
  });

  describe('POST .../items', () => {
    it('a missing required field is 422 with errors keyed by the field, and writes no item', async () => {
      const before = await db.item.count({ where: { teamId } });
      const res = await member.post(`${base()}/items`, { data: { amount: 5 } }).expect(422);
      expect(res.body).toEqual({ errors: { title: ['Required'], contact: ['Required'] } });
      expect(await db.item.count({ where: { teamId } })).toBe(before);
    });

    it('a bad value, an empty optional number and an unknown key are 422 with the same messages validateCapture gives', async () => {
      const res = await member.post(`${base()}/items`, { data: { title: 'x'.repeat(41), amount: '', contact: 'nope', colour: 'red' } }).expect(422);
      expect(res.body).toEqual({ errors: { title: ['Must be at most 40 characters'], amount: ['Must be a number'], contact: ['Must be an email address'], colour: ['Unknown field'] } });
    });

    it('a JSON body over 100 kB is 413: the bound on validation cost assumes it (docs/capture.md)', async () => {
      await member.post(`${base()}/items`, { data: { title: 'x'.repeat(101 * 1024) } }).expect(413);
    });

    it('a body without a data object is 400', async () => {
      await member.post(`${base()}/items`, { title: 'x' }).expect(400);
    });

    it('a good item is 201: a `captured` ItemEvent row, against the latest version, inside the capture.submit span', async () => {
      const res = await member.post(`${base()}/items`, { data: { title: 'Laptop', contact: 'm@example.test' } }).expect(201);
      // The work type has no steps, so processing (GWP#5) completes the item straight away.
      expect(res.body).toMatchObject({ teamId, workTypeVersionId: workType.version.id, status: 'completed', data: { title: 'Laptop', contact: 'm@example.test' } });
      const events = await db.itemEvent.findMany({ where: { itemId: res.body.id }, orderBy: { seq: 'asc' } });
      expect(events).toEqual([
        expect.objectContaining({ seq: 1, type: 'captured', actorSubject: sub('member'), payload: { workTypeVersionId: workType.version.id } }),
        expect.objectContaining({ seq: 2, type: 'completed' }),
      ]);
      const submit = spans.getFinishedSpans().filter((s) => s.name === 'capture.submit');
      expect(submit).toHaveLength(1);
      expect(submit[0]?.attributes).toEqual({ 'work_type.id': workType.id, 'work_type.version': 1 });
    });

    it('a non-member gets 403, and another team\'s work type id is 404', async () => {
      await outsider.post(`${base()}/items`, { data: { title: 'x', contact: 'o@example.test' } }).expect(403);
      const otherTeam = (await outsider.post('/api/v1/teams', { name: 'Other' }).expect(201)).body.id;
      await outsider.post(`/api/v1/teams/${otherTeam}/work-types/${workType.id}/items`, { data: { title: 'x', contact: 'o@example.test' } }).expect(404);
      await outsider.post(`/api/v1/teams/${otherTeam}/work-types/not-a-uuid/items`, { data: {} }).expect(404);
    });
  });

  describe('POST .../versions', () => {
    it('a member who is not an admin gets 403', async () => {
      await member.post(`${base()}/versions`, { definition: threeFields }).expect(403);
    });

    it('a catastrophic pattern is 422 keyed by its path and writes no version row', async () => {
      const unsafe = definition([{ key: 'title', label: 'Title', type: 'text', required: true, pattern: '(a+)+$' }]);
      const before = await db.workTypeVersion.count({ where: { workTypeId: workType.id } });
      const res = await admin.post(`${base()}/versions`, { definition: unsafe }).expect(422);
      expect(res.body).toEqual({ errors: { 'definition.fields.0.pattern': ['Pattern could take too long to check: a repeated group contains a repeat'] } });
      expect(await db.workTypeVersion.count({ where: { workTypeId: workType.id } })).toBe(before);
    });

    it('creating a work type with a catastrophic pattern is refused the same way (422 `{ errors }`, GWP#21) and writes nothing', async () => {
      const unsafe = definition([{ key: 'title', label: 'Title', type: 'text', required: true, pattern: '(a+)+$' }]);
      const res = await admin.post(`/api/v1/teams/${teamId}/work-types`, { slug: 'unsafe', definition: unsafe }).expect(422);
      expect(res.body).toEqual({ errors: { 'definition.fields.0.pattern': ['Pattern could take too long to check: a repeated group contains a repeat'] } });
      expect(await db.workType.count({ where: { teamId, slug: 'unsafe' } })).toBe(0);
    });

    it('an item submitted after a new version is stored against the new workTypeVersionId and validated by its fields', async () => {
      const next = definition([{ key: 'title', label: 'Title', type: 'text', required: true }, { key: 'urgent', label: 'Urgent', type: 'boolean', required: true }]);
      const version = (await admin.post(`${base()}/versions`, { definition: next }).expect(201)).body.version;
      expect(version).toMatchObject({ version: 2 });
      const rejected = await member.post(`${base()}/items`, { data: { title: 'Desk', contact: 'm@example.test' } }).expect(422);
      expect(rejected.body).toEqual({ errors: { urgent: ['Required'], contact: ['Unknown field'] } });
      const res = await member.post(`${base()}/items`, { data: { title: 'Desk', urgent: true } }).expect(201);
      expect(res.body.workTypeVersionId).toBe(version.id);
      expect((await db.item.findUniqueOrThrow({ where: { id: res.body.id } })).workTypeVersionId).toBe(version.id);
      expect(spans.getFinishedSpans().find((s) => s.name === 'capture.submit' && s.attributes['work_type.version'] === 2)).toBeDefined();
    });
  });

  describe('GET .../items', () => {
    it('lists the work type\'s items across its versions, newest first, to members only', async () => {
      const list = await member.get(`${base()}/items`).expect(200);
      expect(list.body.items.map((i: { data: { title: string } }) => i.data.title)).toEqual(['Desk', 'Laptop']);
      expect(list.body.nextCursor).toBeNull();
      await outsider.get(`${base()}/items`).expect(403);
    });

    // GWP#21: the list had a hard cap of 100 and no paging.
    it('pages with a cursor past 100 items, newest first, each item once, rows sharing a timestamp included', async () => {
      const paged = (await admin.post(`/api/v1/teams/${teamId}/work-types`, { slug: 'paged', definition: threeFields }).expect(201)).body;
      // Seven timestamps for 205 rows: most rows share their createdAt with others, so the cursor must
      // order by (createdAt, id), not createdAt alone.
      const at = (i: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, i % 7));
      await db.item.createMany({ data: Array.from({ length: 205 }, (_, i) => ({ teamId, workTypeVersionId: paged.version.id, data: { title: `t${i}` }, createdAt: at(i) })) });
      const expected = (await db.item.findMany({ where: { workTypeVersionId: paged.version.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } })).map((i) => i.id);
      const seen: string[] = [];
      const sizes: number[] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
        const page = (await member.get(`/api/v1/teams/${teamId}/work-types/${paged.id}/items${query}`).expect(200)).body as { items: { id: string }[]; nextCursor: string | null };
        sizes.push(page.items.length);
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
      } while (cursor !== null && sizes.length < 10);
      expect(sizes).toEqual([100, 100, 5]);
      expect(seen).toEqual(expected);
    });

    // GWP#54: one status at a time, newest first, across versions; the cursor stays within the filter.
    it('?status=failed lists only failed items across versions, newest first, and its cursor continues the filter', async () => {
      const filtered = (await admin.post(`/api/v1/teams/${teamId}/work-types`, { slug: 'filtered', definition: threeFields }).expect(201)).body;
      const second = (await admin.post(`/api/v1/teams/${teamId}/work-types/${filtered.id}/versions`, { definition: threeFields }).expect(201)).body;
      const versions = [filtered.version.id as string, second.version.id as string];
      const at = (i: number) => new Date(Date.UTC(2026, 9, 2, 0, 0, i % 5));
      // 130 failed rows among 260, over two versions and five timestamps: the failed ones need two pages.
      await db.item.createMany({ data: Array.from({ length: 260 }, (_, i) => ({ teamId, workTypeVersionId: versions[i % 2] as string, data: { title: `t${i}` }, createdAt: at(i), status: i % 2 === 0 ? 'failed' as const : 'open' as const })) });
      const expected = (await db.item.findMany({ where: { workTypeVersionId: { in: versions }, status: 'failed' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } })).map((i) => i.id);
      expect(expected).toHaveLength(130);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = cursor === null ? '?status=failed' : `?status=failed&cursor=${encodeURIComponent(cursor)}`;
        const page = (await member.get(`/api/v1/teams/${teamId}/work-types/${filtered.id}/items${query}`).expect(200)).body as { items: { id: string; status: string }[]; nextCursor: string | null };
        expect(page.items.every((i) => i.status === 'failed')).toBe(true);
        seen.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 5);
      expect(pages).toBe(2);
      expect(seen).toEqual(expected);
      // Without the filter the same work type lists all 260.
      const all = (await member.get(`/api/v1/teams/${teamId}/work-types/${filtered.id}/items`).expect(200)).body as { items: unknown[]; nextCursor: string | null };
      expect(all.items).toHaveLength(100);
      expect(all.nextCursor).not.toBeNull();
      // A status no item has is an empty page.
      expect((await member.get(`/api/v1/teams/${teamId}/work-types/${filtered.id}/items?status=cancelled`).expect(200)).body).toEqual({ items: [], nextCursor: null });
    });

    it('a status that is not an item status, an empty one or a repeated one is 400 `Invalid status`', async () => {
      for (const query of ['status=nope', 'status=', 'status=failed&status=open', 'status=FAILED']) {
        expect((await member.get(`${base()}/items?${query}`).expect(400)).body.message, query).toBe('Invalid status');
      }
    });

    it('a cursor that is not one the list gave out is 400', async () => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      // Each of the last three reads back as itself, but Postgres refuses it (branch review): a 500 before.
      const forged = [encode(['2026-01-01T00:00:00.000Z', 'a\u0000b']), encode(['0000-01-01T00:00:00.000Z', randomUUID()]), encode(['-271821-04-20T00:00:00.000Z', randomUUID()])];
      for (const cursor of ['nope', encode(['not a date', 'x']), encode({}), ...forged]) {
        await member.get(`${base()}/items?cursor=${encodeURIComponent(cursor)}`).expect(400);
      }
    });
  });
});

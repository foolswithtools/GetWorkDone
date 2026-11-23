import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { ExportResponse, WorkTypeDefinition, WorkTypeResponse } from '@getworkdone/contracts';
import { createPrismaClient } from '@getworkdone/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { signIn, type SignedIn } from './support/identity.js';
import { fakeWebDist } from './support/web-dist.js';

// Exports (GWP#6, docs/outputs.md): a CSV or JSON file of a work type's completed items, generated on
// request, stored in an Export row and downloadable by the team's members only. GWP#25 bounds them: at
// most 10 per work type, none older than 7 days, and one per work type every 30 seconds. The suite's
// clock is the app's (distribute `now`), so it steps past the 30 seconds instead of waiting.
const run = randomUUID().slice(0, 8);
const sub = (name: string) => `export-${name}-${run}`;

// Deliberately not alphabetical: the header must follow the definition's order.
const fields: WorkTypeDefinition['fields'] = [
  { key: 'title', label: 'Title', type: 'text', required: true },
  { key: 'amount', label: 'Amount', type: 'number', required: false },
  { key: 'approved', label: 'Approved', type: 'boolean', required: false },
];

describe('export', () => {
  let app: INestApplication;
  const db = createPrismaClient();
  let admin: SignedIn;
  let member: SignedIn;
  let outsider: SignedIn;
  let teamId: string;
  let workType: WorkTypeResponse;
  const itemIds: string[] = [];
  let clock = new Date();
  const later = (ms: number) => (clock = new Date(clock.getTime() + ms));

  const exportsPath = (id = workType.id) => `/api/v1/teams/${teamId}/work-types/${id}/exports`;
  /** A new export of the work type, 31 seconds after the last one, so the 30-second limit lets it through. */
  const generate = async (as: SignedIn, body: object = {}, id = workType.id): Promise<ExportResponse> => {
    later(31_000);
    return (await as.post(exportsPath(id), body).expect(201)).body as ExportResponse;
  };
  const exportable = async (slug: string): Promise<WorkTypeResponse> =>
    (await admin.post(`/api/v1/teams/${teamId}/work-types`, { slug, definition: { fields, steps: [], outputs: [{ id: 'file', kind: 'export', config: { format: 'csv' } }] } }).expect(201)).body as WorkTypeResponse;

  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false, distribute: { now: () => clock } });
    await app.init();
    admin = await signIn(app, sub('admin'));
    member = await signIn(app, sub('member'));
    outsider = await signIn(app, sub('outsider'));
    teamId = (await admin.post('/api/v1/teams', { name: 'Export' }).expect(201)).body.id;
    await db.teamMember.create({ data: { teamId, subject: sub('member'), role: 'member' } });
    workType = (await admin.post(`/api/v1/teams/${teamId}/work-types`, { slug: 'expenses', definition: { fields, steps: [], outputs: [{ id: 'file', kind: 'export', config: { format: 'csv' } }] } }).expect(201)).body;
    for (const data of [{ title: 'Taxi', amount: 12.5, approved: true }, { title: 'Hotel, "deluxe"\nroom', amount: 200 }, { title: '=HYPERLINK("http://x")' }]) {
      itemIds.push((await member.post(`/api/v1/teams/${teamId}/work-types/${workType.id}/items`, { data }).expect(201)).body.id);
    }
    // A second version with a human step: its item is captured but not completed, so it is not exported.
    await admin.post(`/api/v1/teams/${teamId}/work-types/${workType.id}/versions`, {
      definition: { fields, steps: [{ id: 'review', name: 'Review', kind: 'human', assigneeRole: 'admin' }], outputs: [{ id: 'file', kind: 'export', config: { format: 'csv' } }] },
    }).expect(201);
    await member.post(`/api/v1/teams/${teamId}/work-types/${workType.id}/items`, { data: { title: 'Not done yet' } }).expect(201);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('CSV header order follows field order; completed items only, oldest first, cells escaped', async () => {
    const created = await generate(member);
    expect(created).toMatchObject({ workTypeId: workType.id, format: 'csv', itemCount: 3, createdBySubject: sub('member') });
    const download = await member.get(`/api/v1/teams/${teamId}/exports/${created.id}/download`).expect(200);
    expect(download.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(download.headers['content-disposition']).toBe(`attachment; filename="expenses-${created.id}.csv"`);
    // Exactly once: every response carries nosniff (GWP#48, docs/security.md) and the route's own
    // setHeader replaces it. Node joins a repeated header with ", ", so a second copy fails this.
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    const text = download.text;
    expect(created.sizeBytes).toBe(Buffer.byteLength(text));
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('item_id,completed_at,title,amount,approved');
    expect(lines[1]).toMatch(new RegExp(`^${itemIds[0]},\\d{4}-\\d\\d-\\d\\dT[^,]+Z,Taxi,12.5,true$`));
    expect(text).toContain(`${itemIds[1]},`);
    expect(text).toContain(',"Hotel, ""deluxe""\nroom",200,\r\n');
    // A formula is written as text, so a spreadsheet does not run it.
    expect(text).toContain(`,"'=HYPERLINK(""http://x"")",,\r\n`);
    expect(text).not.toContain('Not done yet');
  });

  it('JSON is an array of completed items with their data', async () => {
    const created = await generate(admin, { format: 'json' });
    const download = await admin.get(`/api/v1/teams/${teamId}/exports/${created.id}/download`).expect(200);
    expect(download.headers['content-type']).toBe('application/json; charset=utf-8');
    const body = JSON.parse(download.text) as { id: string; completedAt: string; data: Record<string, unknown> }[];
    expect(body.map((i) => i.id)).toEqual(itemIds);
    expect(body[0]).toEqual({ id: itemIds[0], completedAt: expect.any(String), data: { title: 'Taxi', amount: 12.5, approved: true } });
  });

  it('lists the work type\'s exports, newest first', async () => {
    const listed = (await member.get(exportsPath()).expect(200)).body as ExportResponse[];
    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(listed[0]?.format).toBe('json');
  });

  it('a non-member gets 403', async () => {
    const created = await generate(admin);
    await outsider.post(exportsPath(), {}).expect(403);
    await outsider.get(exportsPath()).expect(403);
    await outsider.get(`/api/v1/teams/${teamId}/exports/${created.id}/download`).expect(403);
    // From the outsider's own team the export does not exist.
    const otherTeam = (await outsider.post('/api/v1/teams', { name: 'Other' }).expect(201)).body.id as string;
    await outsider.get(`/api/v1/teams/${otherTeam}/exports/${created.id}/download`).expect(404);
  });

  it('a work type without an export output cannot be exported; a bad format is 400', async () => {
    const plain = (await admin.post(`/api/v1/teams/${teamId}/work-types`, { slug: 'plain', definition: { fields, steps: [], outputs: [{ id: 'keep', kind: 'persist', config: {} }] } }).expect(201)).body as WorkTypeResponse;
    const refused = await admin.post(`/api/v1/teams/${teamId}/work-types/${plain.id}/exports`, {}).expect(422);
    expect(refused.body.message).toBe('This work type has no export output');
    await admin.post(exportsPath(), { format: 'xml' }).expect(400);
    await admin.post(`/api/v1/teams/${teamId}/work-types/${randomUUID()}/exports`, {}).expect(404);
  });

  it('the eleventh export of a work type deletes the oldest: 10 are listed and the first is 404', async () => {
    const kept = await exportable('kept');
    const made: ExportResponse[] = [];
    for (let i = 0; i < 11; i++) made.push(await generate(member, {}, kept.id));
    const listed = (await member.get(exportsPath(kept.id)).expect(200)).body as ExportResponse[];
    expect(listed.map((e) => e.id)).toEqual(made.slice(1).map((e) => e.id).reverse());
    expect(await db.export.count({ where: { workTypeId: kept.id } })).toBe(10);
    await member.get(`/api/v1/teams/${teamId}/exports/${made[0]?.id}/download`).expect(404);
    await member.get(`/api/v1/teams/${teamId}/exports/${made[1]?.id}/download`).expect(200);
  });

  it('an export older than 7 days is deleted when the team generates a new one, of any work type', async () => {
    const old = await exportable('old');
    const other = await exportable('other');
    const stale = await generate(member, {}, old.id);
    later(7 * 24 * 3600_000 - 31_000);
    const fresh = await generate(member, {}, old.id);
    // Exactly 7 days old is kept; the cut is strictly older.
    expect(await db.export.findUnique({ where: { id: stale.id }, select: { id: true } })).not.toBeNull();
    later(24 * 3600_000);
    await generate(member, {}, other.id);
    expect(await db.export.findUnique({ where: { id: stale.id }, select: { id: true } })).toBeNull();
    await member.get(`/api/v1/teams/${teamId}/exports/${stale.id}/download`).expect(404);
    expect((await member.get(exportsPath(old.id)).expect(200)).body.map((e: ExportResponse) => e.id)).toEqual([fresh.id]);
  });

  it('a second export of a work type within 30 seconds is 429 with Retry-After and stores no row', async () => {
    const busy = await exportable('busy');
    const quiet = await exportable('quiet');
    await generate(member, {}, busy.id);
    later(10_000);
    const refused = await admin.post(exportsPath(busy.id), { format: 'json' }).expect(429);
    expect(refused.headers['retry-after']).toBe('20');
    expect(await db.export.count({ where: { workTypeId: busy.id } })).toBe(1);
    // Another work type of the same team is not held back.
    await member.post(exportsPath(quiet.id), {}).expect(201);
    later(19_500);
    expect((await member.post(exportsPath(busy.id), {}).expect(429)).headers['retry-after']).toBe('1');
    later(500);
    await member.post(exportsPath(busy.id), {}).expect(201);
    expect(await db.export.count({ where: { workTypeId: busy.id } })).toBe(2);
  });

  it('two exports of a work type asked for at once store one', async () => {
    const raced = await exportable('raced');
    later(31_000);
    const statuses = (await Promise.all([member.post(exportsPath(raced.id), {}), admin.post(exportsPath(raced.id), {})])).map((r) => r.status).sort();
    expect(statuses).toEqual([201, 429]);
    expect(await db.export.count({ where: { workTypeId: raced.id } })).toBe(1);
  });
});

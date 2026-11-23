import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createPrismaClient } from '@getworkdone/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { WorkTypesService } from '../src/modules/work-types/work-types.service.js';
import { definition } from './support/definitions.js';
import { signIn, type SignedIn } from './support/identity.js';
import { fakeWebDist } from './support/web-dist.js';

describe('work types', () => {
  let app: INestApplication;
  const db = createPrismaClient();
  let teamId: string;
  let carol: SignedIn;
  const post = (path: string, body: unknown) => carol.post(path, body as object);

  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
    carol = await signIn(app, 'carol');
    teamId = (await post('/api/v1/teams', { name: 'Work types' }).expect(201)).body.id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('POST writes the work type and its version 1 with the parsed definition (defaults filled in)', async () => {
    const def = definition();
    delete (def.fields[0] as { required?: boolean }).required;
    const res = await post(`/api/v1/teams/${teamId}/work-types`, { slug: 'intake', definition: def }).expect(201);
    expect(res.body).toMatchObject({ teamId, slug: 'intake', version: { version: 1 } });
    expect(res.body.version.definition.fields[0].required).toBe(false);
  });

  // GWP#21: one error shape for an invalid definition, the same as POST .../versions (capture.md).
  it('POST answers an invalid definition 422 `{ errors }` keyed by path and writes no row', async () => {
    const before = await db.workType.count({ where: { teamId } });
    const unsafe = { ...definition(), fields: [{ key: 'title', label: 'Title', type: 'text', pattern: '(a+)+$' }] };
    const invalid = await post(`/api/v1/teams/${teamId}/work-types`, { slug: 'unsafe', definition: unsafe }).expect(422);
    expect(Object.keys(invalid.body)).toEqual(['errors']);
    expect(invalid.body.errors).toEqual({ 'definition.fields.0.pattern': [expect.stringContaining('could take too long')] });
    const outputs = { ...definition(), outputs: [{ id: 'a', kind: 'none', config: {} }, { id: 'b', kind: 'email', config: {} }] };
    const excluded = await post(`/api/v1/teams/${teamId}/work-types`, { slug: 'bad', definition: outputs }).expect(422);
    expect(JSON.stringify(excluded.body.errors)).toContain('output `none` excludes every other output');
    expect((await post(`/api/v1/teams/${teamId}/work-types`, { definition: definition() }).expect(422)).body.errors).toHaveProperty('slug');
    expect((await post(`/api/v1/teams/${teamId}/work-types`, []).expect(422)).body.errors).toHaveProperty('_form');
    expect(await db.workType.count({ where: { teamId } })).toBe(before);
  });

  it('POST rejects a duplicate slug with 409 and a body that is not JSON with 400', async () => {
    await post(`/api/v1/teams/${teamId}/work-types`, { slug: 'dup', definition: definition() }).expect(201);
    await post(`/api/v1/teams/${teamId}/work-types`, { slug: 'dup', definition: definition() }).expect(409);
    await post('/api/v1/teams', { name: '' }).expect(400);
    await request(app.getHttpServer()).post(`/api/v1/teams/${teamId}/work-types`).set('cookie', carol.cookie).set('x-gwd-csrf', carol.csrfToken).set('content-type', 'application/json').send('{not json').expect(400);
  });

  it('changing a definition through the service writes the next version row; version 1 is never updated', async () => {
    const created = (await post(`/api/v1/teams/${teamId}/work-types`, { slug: 'revised', definition: definition('First') }).expect(201)).body;
    const workTypes = app.get(WorkTypesService);
    const revised = await workTypes.reviseDefinition(teamId, created.id, definition('Second'));
    expect(revised.version).toMatchObject({ version: 2 });
    expect(revised.version.id).not.toBe(created.version.id);
    const rows = await db.workTypeVersion.findMany({ where: { workTypeId: created.id }, orderBy: { version: 'asc' } });
    expect(rows.map((r) => [r.version, (r.definition as { fields: { label: string }[] }).fields[0]?.label])).toEqual([[1, 'First'], [2, 'Second']]);
    // The list shows the latest version.
    const list = await carol.get(`/api/v1/teams/${teamId}/work-types`).expect(200);
    expect(list.body.find((w: { id: string }) => w.id === created.id).version.version).toBe(2);
  });

  it('an invalid revision is rejected and writes nothing; an in-place update of a version row is rejected by the database', async () => {
    const created = (await post(`/api/v1/teams/${teamId}/work-types`, { slug: 'locked', definition: definition() }).expect(201)).body;
    await post(`/api/v1/teams/${teamId}/work-types/${created.id}/versions`, { definition: { ...definition(), fields: [] } }).expect(422);
    await expect(db.workTypeVersion.update({ where: { id: created.version.id }, data: { definition: { ...definition('Edited') } as object } })).rejects.toThrow(/WorkTypeVersion is immutable/);
    expect(await db.workTypeVersion.count({ where: { workTypeId: created.id } })).toBe(1);
  });

  // GWP#55: archive retires a work type; its items, the item view and its exports stay readable.
  describe('archive', () => {
    let member: SignedIn;
    const memberSubject = `archive-member-${randomUUID().slice(0, 8)}`;
    const exportable = () => ({ ...definition(), steps: [], outputs: [{ id: 'file', kind: 'export', config: { format: 'csv' } }] });
    const listSlugs = async (query = '') => ((await carol.get(`/api/v1/teams/${teamId}/work-types${query}`).expect(200)).body as { slug: string; archivedAt: string | null }[]);

    beforeAll(async () => {
      member = await signIn(app, memberSubject);
      await post(`/api/v1/teams/${teamId}/members`, { subject: memberSubject, role: 'member' }).expect(201);
    });

    it('an admin archives: 200 with archivedAt set; a member is 403; the list omits it unless ?includeArchived=true', async () => {
      const created = (await post(`/api/v1/teams/${teamId}/work-types`, { slug: 'retired', definition: definition() }).expect(201)).body;
      expect(created.archivedAt).toBeNull();
      await member.post(`/api/v1/teams/${teamId}/work-types/${created.id}/archive`, {}).expect(403);
      expect((await listSlugs()).find((w) => w.slug === 'retired')).toMatchObject({ archivedAt: null });

      const archived = (await post(`/api/v1/teams/${teamId}/work-types/${created.id}/archive`, {}).expect(200)).body;
      expect(archived).toMatchObject({ id: created.id, slug: 'retired', version: { version: 1 }, archivedAt: expect.any(String) });
      expect(Number.isNaN(Date.parse(archived.archivedAt))).toBe(false);
      // Archiving again keeps the first archivedAt.
      expect((await post(`/api/v1/teams/${teamId}/work-types/${created.id}/archive`, {}).expect(200)).body.archivedAt).toBe(archived.archivedAt);
      expect((await listSlugs()).map((w) => w.slug)).not.toContain('retired');
      expect((await listSlugs('?includeArchived=true')).find((w) => w.slug === 'retired')).toMatchObject({ archivedAt: archived.archivedAt });
      expect((await listSlugs('?includeArchived=false')).map((w) => w.slug)).not.toContain('retired');
      await carol.get(`/api/v1/teams/${teamId}/work-types?includeArchived=yes`).expect(400);
      await member.post(`/api/v1/teams/${teamId}/work-types/${created.id}/unarchive`, {}).expect(403);
    });

    it('capture on an archived work type is 409 and writes nothing; a new version is 409; unarchive restores both', async () => {
      const created = (await post(`/api/v1/teams/${teamId}/work-types`, { slug: 'paused', definition: definition() }).expect(201)).body;
      await post(`/api/v1/teams/${teamId}/work-types/${created.id}/archive`, {}).expect(200);
      const before = await db.item.count({ where: { teamId } });
      const refused = await member.post(`/api/v1/teams/${teamId}/work-types/${created.id}/items`, { data: { title: 'late' } }).expect(409);
      expect(refused.body.message).toBe('This work type is archived');
      expect(await db.item.count({ where: { teamId } })).toBe(before);
      const version = await post(`/api/v1/teams/${teamId}/work-types/${created.id}/versions`, { definition: definition('Changed') }).expect(409);
      expect(version.body.message).toBe('This work type is archived');
      expect(await db.workTypeVersion.count({ where: { workTypeId: created.id } })).toBe(1);

      const restored = (await post(`/api/v1/teams/${teamId}/work-types/${created.id}/unarchive`, {}).expect(200)).body;
      expect(restored.archivedAt).toBeNull();
      expect((await listSlugs()).map((w) => w.slug)).toContain('paused');
      await member.post(`/api/v1/teams/${teamId}/work-types/${created.id}/items`, { data: { title: 'on time' } }).expect(201);
      await post(`/api/v1/teams/${teamId}/work-types/${created.id}/versions`, { definition: definition('Changed') }).expect(201);
    });

    it('an item of an archived work type is still readable, listed and exported, and its export downloads', async () => {
      const created = (await post(`/api/v1/teams/${teamId}/work-types`, { slug: 'old-expenses', definition: exportable() }).expect(201)).body;
      const item = (await member.post(`/api/v1/teams/${teamId}/work-types/${created.id}/items`, { data: { title: 'Taxi' } }).expect(201)).body;
      expect(item.status).toBe('completed');
      await post(`/api/v1/teams/${teamId}/work-types/${created.id}/archive`, {}).expect(200);
      expect((await member.get(`/api/v1/teams/${teamId}/items/${item.id}`).expect(200)).body).toMatchObject({ id: item.id, data: { title: 'Taxi' } });
      expect((await member.get(`/api/v1/teams/${teamId}/work-types/${created.id}/items`).expect(200)).body.items.map((i: { id: string }) => i.id)).toEqual([item.id]);
      const made = (await member.post(`/api/v1/teams/${teamId}/work-types/${created.id}/exports`, {}).expect(201)).body;
      expect(made.itemCount).toBe(1);
      const download = await member.get(`/api/v1/teams/${teamId}/exports/${made.id}/download`).expect(200);
      expect(download.text).toContain('Taxi');
    });

    it('archive and unarchive refuse a body with keys (400), an unknown work type (404) and another team\'s (404)', async () => {
      const created = (await post(`/api/v1/teams/${teamId}/work-types`, { slug: 'strict', definition: definition() }).expect(201)).body;
      await post(`/api/v1/teams/${teamId}/work-types/${created.id}/archive`, { now: true }).expect(400);
      await post(`/api/v1/teams/${teamId}/work-types/${randomUUID()}/archive`, {}).expect(404);
      await post(`/api/v1/teams/${teamId}/work-types/${randomUUID()}/unarchive`, {}).expect(404);
      const other = (await member.post('/api/v1/teams', { name: 'Archive other' }).expect(201)).body.id;
      const theirs = (await member.post(`/api/v1/teams/${other}/work-types`, { slug: 'theirs', definition: definition() }).expect(201)).body;
      await post(`/api/v1/teams/${teamId}/work-types/${theirs.id}/archive`, {}).expect(404);
      expect((await db.workType.findUniqueOrThrow({ where: { id: theirs.id } })).archivedAt).toBeNull();
    });
  });
});

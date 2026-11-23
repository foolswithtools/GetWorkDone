import type { INestApplication } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { createPrismaClient } from '@getworkdone/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ItemsService } from '../src/modules/items/items.service.js';
import { WorkTypesService } from '../src/modules/work-types/work-types.service.js';
import { definition } from './support/definitions.js';
import { signIn, type SignedIn } from './support/identity.js';
import { fakeWebDist } from './support/web-dist.js';

// Tenancy is team-scoped rows (spec §4.3): every query takes teamId, and a read across teams is a 404,
// never another team's row.
describe('tenancy', () => {
  let app: INestApplication;
  const db = createPrismaClient();
  const sessions: Record<string, SignedIn> = {};
  const as = (subject: string) => sessions[subject]!;
  let teamA: string;
  let teamB: string;
  let workTypeB: { id: string; version: { id: string } };
  let itemB: string;

  beforeAll(async () => {
    app = await createApp({ webDistDir: fakeWebDist(), logger: false });
    await app.init();
    for (const subject of ['alice', 'bob']) sessions[subject] = await signIn(app, subject);
    teamA = (await as('alice').post('/api/v1/teams', { name: 'Team A' }).expect(201)).body.id;
    teamB = (await as('bob').post('/api/v1/teams', { name: 'Team B' }).expect(201)).body.id;
    workTypeB = (await as('bob').post(`/api/v1/teams/${teamB}/work-types`, { slug: 'orders', definition: definition() }).expect(201)).body;
    // No capture route yet (GWP#4): the item is written through the service, as capture will.
    itemB = (await app.get(ItemsService).create(teamB, { workTypeVersionId: workTypeB.version.id, data: { title: 'B' } }, 'bob')).id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('team A cannot read team B\'s work type: the service answers not found, and A\'s list leaves it out', async () => {
    const workTypes = app.get(WorkTypesService);
    await expect(workTypes.get(teamA, workTypeB.id)).rejects.toBeInstanceOf(NotFoundException);
    expect((await workTypes.get(teamB, workTypeB.id)).id).toBe(workTypeB.id);
    const listA = await as('alice').get(`/api/v1/teams/${teamA}/work-types`).expect(200);
    expect(listA.body).toEqual([]);
    const listB = await as('bob').get(`/api/v1/teams/${teamB}/work-types`).expect(200);
    expect(listB.body.map((w: { id: string }) => w.id)).toEqual([workTypeB.id]);
  });

  it('team A cannot read team B\'s item through team A: GET under team A is 404, under team B it is the item with its audit trail', async () => {
    const crossTeam = await as('alice').get(`/api/v1/teams/${teamA}/items/${itemB}`);
    expect(crossTeam.status).toBe(404);
    expect(JSON.stringify(crossTeam.body)).not.toContain('"title"');
    const own = await as('bob').get(`/api/v1/teams/${teamB}/items/${itemB}`).expect(200);
    expect(own.body).toMatchObject({ id: itemB, teamId: teamB, status: 'open', currentStepIndex: 0, rowVersion: 0, data: { title: 'B' } });
    expect(own.body.events).toEqual([expect.objectContaining({ seq: 1, type: 'item.created', actorSubject: 'bob' })]);
  });

  it('an item cannot be created in team A from team B\'s work type version', async () => {
    await expect(app.get(ItemsService).create(teamA, { workTypeVersionId: workTypeB.version.id, data: {} }, 'alice')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a team that does not exist is 403 for its work types and items, as is a malformed id: no membership (GWP#3)', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    await as('alice').get(`/api/v1/teams/${missing}/work-types`).expect(403);
    await as('alice').post(`/api/v1/teams/${missing}/work-types`, { slug: 'x', definition: definition() }).expect(403);
    await as('alice').get(`/api/v1/teams/not-a-uuid/items/also-not`).expect(403);
  });

  it('an item that does not exist in the caller\'s own team is 404, as is a malformed item id', async () => {
    await as('alice').get(`/api/v1/teams/${teamA}/items/00000000-0000-4000-8000-000000000000`).expect(404);
    await as('alice').get(`/api/v1/teams/${teamA}/items/not-a-uuid`).expect(404);
  });

  it('the services still scope by team, behind the membership guard: a missing team is not found', async () => {
    await expect(app.get(WorkTypesService).list('00000000-0000-4000-8000-000000000000')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('GET /api/v1/teams lists the teams the identity belongs to; the creator is the team\'s admin', async () => {
    const alice = await as('alice').get('/api/v1/teams').expect(200);
    const ids = alice.body.map((t: { id: string }) => t.id);
    expect(ids).toContain(teamA);
    expect(ids).not.toContain(teamB);
    expect(await db.teamMember.findMany({ where: { teamId: teamA }, select: { subject: true, role: true } })).toEqual([{ subject: 'alice', role: 'admin' }]);
  });

  it('ItemEvent rows cannot be updated or deleted: the database trigger raises', async () => {
    await expect(db.$executeRaw`UPDATE "ItemEvent" SET "payload" = '{}' WHERE "itemId" = ${itemB}`).rejects.toThrow(/ItemEvent is append-only/);
    await expect(db.$executeRaw`DELETE FROM "ItemEvent" WHERE "itemId" = ${itemB}`).rejects.toThrow(/ItemEvent is append-only/);
    expect(await db.itemEvent.count({ where: { itemId: itemB } })).toBe(1);
  });
});

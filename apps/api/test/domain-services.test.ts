import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@getworkdone/db';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_QUOTAS, QuotaLimiter } from '../src/common/quota.js';
import type { Database } from '../src/modules/database/database.js';
import { ItemsService } from '../src/modules/items/items.service.js';
import { TeamsService } from '../src/modules/teams/teams.service.js';
import { toWorkTypeResponse, WorkTypesService } from '../src/modules/work-types/work-types.service.js';
import { definition } from './support/definitions.js';

// Unit partition: the services against a stand-in Prisma client, checking that every query is scoped
// by teamId and how database outcomes map to HTTP errors. The real database is in the integration tests.
const at = new Date('2026-10-21T00:00:00.000Z');
const team = { id: 'team-a', name: 'A', createdAt: at };
const member = { id: 'm1', teamId: 'team-a', subject: 'alice', role: 'admin', createdAt: at };
const version = { id: 'v1', teamId: 'team-a', workTypeId: 'wt', version: 1, definition: definition(), createdAt: at };
const workType = { id: 'wt', teamId: 'team-a', slug: 'orders', createdAt: at, archivedAt: null, versions: [version] };
const item = { id: 'i1', teamId: 'team-a', workTypeVersionId: 'v1', data: { title: 'x' }, status: 'open', currentStepIndex: 0, rowVersion: 0, waitingRole: null, createdAt: at, updatedAt: at };
const event = { id: 'e1', itemId: 'i1', seq: 1, type: 'item.created', actorSubject: 'alice', at, payload: { workTypeVersionId: 'v1' } };

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
}

function fakeDb() {
  const client = {
    team: { create: vi.fn(async () => team), findMany: vi.fn(async () => [team]), findUnique: vi.fn(async (): Promise<object | null> => ({ id: team.id })) },
    teamMember: {
      findMany: vi.fn(async () => [member]), create: vi.fn(async (): Promise<object> => member), findUnique: vi.fn(async (): Promise<object | null> => member),
      count: vi.fn(async () => 2), delete: vi.fn(async () => member),
    },
    identity: { findMany: vi.fn(async (): Promise<object[]> => []) },
    $queryRaw: vi.fn(async () => [{ id: team.id }]),
    workType: { findMany: vi.fn(async () => [workType]), findFirst: vi.fn(async (): Promise<object | null> => workType), create: vi.fn(async () => ({ ...workType, versions: undefined })),
      count: vi.fn(async () => 0), updateMany: vi.fn(async () => ({ count: 1 })) },
    workTypeVersion: { create: vi.fn(async (): Promise<object> => version), findFirst: vi.fn(async (): Promise<object | null> => ({ id: 'v1' })) },
    item: { create: vi.fn(async () => item), findMany: vi.fn(async () => [{ ...item, events: [event] }]), findFirst: vi.fn(async (): Promise<object | null> => ({ ...item, events: [event], workTypeVersion: { definition: definition() } })) },
    itemEvent: { create: vi.fn(async () => event) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(client)),
  };
  return { db: { client } as unknown as Database, client };
}

describe('TeamsService', () => {
  it('creates the team with its creator as admin, and lists only the subject\'s teams', async () => {
    const { db, client } = fakeDb();
    const teams = new TeamsService(db);
    expect(await teams.create('alice', { name: 'A' })).toEqual({ id: 'team-a', name: 'A', createdAt: at.toISOString() });
    expect(client.team.create).toHaveBeenCalledWith({ data: { name: 'A', members: { create: { subject: 'alice', role: 'admin' } } } });
    await teams.listForSubject('alice');
    expect(client.team.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { members: { some: { subject: 'alice' } } } }));
  });

  it('requireTeam is not found for a team that does not exist', async () => {
    const { db, client } = fakeDb();
    client.team.findUnique.mockResolvedValueOnce(null);
    await expect(new TeamsService(db).requireTeam('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

// GWP#20: team membership. Every query names the team; removing the last admin is refused under the team's row lock.
describe('TeamsService members', () => {
  it('lists, adds and removes members scoped by teamId', async () => {
    const { db, client } = fakeDb();
    const teams = new TeamsService(db);
    expect(await teams.listMembers('team-a')).toEqual([{ subject: 'alice', role: 'admin', createdAt: at.toISOString(), email: null, displayName: null }]);
    expect(client.teamMember.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { teamId: 'team-a' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
    client.teamMember.create.mockResolvedValueOnce({ ...member, subject: 'bob', role: 'member' });
    expect(await teams.addMember('team-a', { subject: 'bob', role: 'member' })).toEqual({ subject: 'bob', role: 'member', createdAt: at.toISOString(), email: null, displayName: null });
    expect(client.teamMember.create).toHaveBeenCalledWith({ data: { teamId: 'team-a', subject: 'bob', role: 'member' } });
    await teams.removeMember('team-a', 'alice');
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
    expect(client.teamMember.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { teamId_subject: { teamId: 'team-a', subject: 'alice' } } }));
    expect(client.teamMember.count).toHaveBeenCalledWith({ where: { teamId: 'team-a', role: 'admin' } });
    expect(client.teamMember.delete).toHaveBeenCalledWith({ where: { teamId_subject: { teamId: 'team-a', subject: 'alice' } } });
  });

  it('each member carries their Identity\'s email and display name, looked up by the team\'s subjects only (GWP#99)', async () => {
    const { db, client } = fakeDb();
    const teams = new TeamsService(db);
    client.teamMember.findMany.mockResolvedValueOnce([member, { ...member, id: 'm2', subject: 'bob', role: 'member' }]);
    client.identity.findMany.mockResolvedValueOnce([{ subject: 'bob', email: 'bob@example.test', displayName: 'Bob' }]);
    expect(await teams.listMembers('team-a')).toEqual([
      { subject: 'alice', role: 'admin', createdAt: at.toISOString(), email: null, displayName: null },
      { subject: 'bob', role: 'member', createdAt: at.toISOString(), email: 'bob@example.test', displayName: 'Bob' },
    ]);
    expect(client.identity.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { subject: { in: ['alice', 'bob'] } } }));
    // A team with no members (never, as a team keeps an admin) makes no Identity query.
    client.identity.findMany.mockClear();
    client.teamMember.findMany.mockResolvedValueOnce([]);
    expect(await teams.listMembers('team-a')).toEqual([]);
    expect(client.identity.findMany).not.toHaveBeenCalled();
  });

  it('adding a subject already in the team is a conflict; other errors pass through', async () => {
    const { db, client } = fakeDb();
    const teams = new TeamsService(db);
    client.teamMember.create.mockRejectedValueOnce(uniqueViolation());
    await expect(teams.addMember('team-a', { subject: 'alice', role: 'member' })).rejects.toBeInstanceOf(ConflictException);
    client.teamMember.create.mockRejectedValueOnce(new Error('down'));
    await expect(teams.addMember('team-a', { subject: 'alice', role: 'member' })).rejects.toThrow('down');
  });

  it('removing the last admin is a conflict, an unknown subject is not found, and a member is removed without counting admins', async () => {
    const { db, client } = fakeDb();
    const teams = new TeamsService(db);
    client.teamMember.count.mockResolvedValueOnce(1);
    await expect(teams.removeMember('team-a', 'alice')).rejects.toBeInstanceOf(ConflictException);
    expect(client.teamMember.delete).not.toHaveBeenCalled();
    client.teamMember.findUnique.mockResolvedValueOnce(null);
    await expect(teams.removeMember('team-a', 'nobody')).rejects.toBeInstanceOf(NotFoundException);
    expect(client.teamMember.delete).not.toHaveBeenCalled();
    client.teamMember.count.mockClear();
    client.teamMember.findUnique.mockResolvedValueOnce({ ...member, subject: 'bob', role: 'member' });
    await teams.removeMember('team-a', 'bob');
    expect(client.teamMember.count).not.toHaveBeenCalled();
    expect(client.teamMember.delete).toHaveBeenCalledWith({ where: { teamId_subject: { teamId: 'team-a', subject: 'bob' } } });
  });
});

describe('WorkTypesService', () => {
  const service = () => {
    const fake = fakeDb();
    return { ...fake, workTypes: new WorkTypesService(fake.db, new TeamsService(fake.db), new QuotaLimiter({ store: { take: () => Promise.reject(new Error('not taken')) }, limits: undefined })) };
  };

  it('scopes list and get by teamId, and another team\'s work type is not found', async () => {
    const { workTypes, client } = service();
    expect((await workTypes.list('team-a'))[0]).toMatchObject({ id: 'wt', version: { version: 1 } });
    expect(client.workType.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { teamId: 'team-a', archivedAt: null } }));
    // GWP#55: archived work types only when asked for.
    await workTypes.list('team-a', { includeArchived: true });
    expect(client.workType.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { teamId: 'team-a' } }));
    client.workType.findFirst.mockResolvedValueOnce(null);
    await expect(workTypes.get('team-b', 'wt')).rejects.toBeInstanceOf(NotFoundException);
    expect(client.workType.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'wt', teamId: 'team-b' } }));
  });

  it('create writes version 1 in one transaction; a taken slug is a conflict, other errors pass through', async () => {
    const { workTypes, client } = service();
    expect(await workTypes.create('team-a', { slug: 'orders', definition: definition() })).toMatchObject({ slug: 'orders', version: { id: 'v1' } });
    expect(client.workTypeVersion.create).toHaveBeenCalledWith({ data: expect.objectContaining({ teamId: 'team-a', workTypeId: 'wt', version: 1 }) });
    client.workType.create.mockRejectedValueOnce(uniqueViolation());
    await expect(workTypes.create('team-a', { slug: 'orders', definition: definition() })).rejects.toBeInstanceOf(ConflictException);
    client.workType.create.mockRejectedValueOnce(new Error('down'));
    await expect(workTypes.create('team-a', { slug: 'orders', definition: definition() })).rejects.toThrow('down');
  });

  it('reviseDefinition checks the steps, then writes the next version; a lost race is a conflict', async () => {
    const { workTypes, client } = service();
    const unknownTransform = { ...definition(), steps: [{ id: 'auto', name: 'Auto', kind: 'automated' as const, transform: 'nope', params: {} }] };
    const refused = await workTypes.reviseDefinition('team-a', 'wt', unknownTransform).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UnprocessableEntityException);
    expect(Object.keys((refused as UnprocessableEntityException).getResponse() as object)).toEqual(['errors']);
    expect(client.workTypeVersion.create).not.toHaveBeenCalled();
    client.workTypeVersion.create.mockResolvedValueOnce({ ...version, id: 'v2', version: 2 });
    // GWP#21: the route parsed the definition; the service stores that value, it does not parse it again.
    const parsed = definition('Next');
    expect((await workTypes.reviseDefinition('team-a', 'wt', parsed)).version).toMatchObject({ id: 'v2', version: 2, definition: parsed });
    expect(client.workTypeVersion.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ teamId: 'team-a', workTypeId: 'wt', version: 2 }) });
    expect((client.workTypeVersion.create.mock.lastCall as unknown as [{ data: { definition: unknown } }])[0].data.definition).toBe(parsed);
    client.workTypeVersion.create.mockRejectedValueOnce(uniqueViolation());
    await expect(workTypes.reviseDefinition('team-a', 'wt', definition())).rejects.toBeInstanceOf(ConflictException);
    client.workTypeVersion.create.mockRejectedValueOnce(new Error('down'));
    await expect(workTypes.reviseDefinition('team-a', 'wt', definition())).rejects.toThrow('down');
  });

  // GWP#103: archived work types do not count; unarchive is checked under the team's row lock.
  it('with a cap, create counts active work types, and unarchive is 404, a no-op when active, 409 at the cap, else clears archivedAt', async () => {
    const fake = fakeDb();
    const { client } = fake;
    const workTypes = new WorkTypesService(fake.db, new TeamsService(fake.db), new QuotaLimiter({ store: { take: () => Promise.reject(new Error('not taken')) }, limits: { ...DEFAULT_QUOTAS, workTypesPerTeam: 3 } }));
    client.workType.count.mockResolvedValueOnce(3);
    await expect(workTypes.create('team-a', { slug: 'orders', definition: definition() })).rejects.toThrow('This team has reached its limit of 3 work types');
    expect(client.workType.count).toHaveBeenLastCalledWith({ where: { teamId: 'team-a', archivedAt: null } });

    client.$queryRaw.mockClear();
    client.workType.findFirst.mockResolvedValueOnce(null);
    await expect(workTypes.setArchived('team-a', 'wt', false)).rejects.toBeInstanceOf(NotFoundException);
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
    expect(await workTypes.setArchived('team-a', 'wt', false)).toMatchObject({ id: 'wt', archivedAt: null });
    expect(client.workType.updateMany).not.toHaveBeenCalled();

    const archived = { ...workType, archivedAt: at };
    client.workType.findFirst.mockResolvedValueOnce(archived);
    client.workType.count.mockResolvedValueOnce(3);
    await expect(workTypes.setArchived('team-a', 'wt', false)).rejects.toThrow('This team has reached its limit of 3 work types');
    expect(client.workType.updateMany).not.toHaveBeenCalled();
    client.workType.findFirst.mockResolvedValueOnce(archived);
    client.workType.count.mockResolvedValueOnce(2);
    await workTypes.setArchived('team-a', 'wt', false);
    expect(client.workType.updateMany).toHaveBeenCalledExactlyOnceWith({ where: { id: 'wt', teamId: 'team-a' }, data: { archivedAt: null } });
  });

  it('a stored definition is returned as written, not re-validated, so a later, stricter contract cannot break old rows', () => {
    const stored = JSON.parse(JSON.stringify({ ...definition(), fields: [] })) as Prisma.JsonObject;
    expect(toWorkTypeResponse({ ...workType, versions: [{ ...version, definition: stored }] }).version.definition).toEqual(stored);
  });

  it('a work type row without a version is a server error, not an empty response', () => {
    expect(() => toWorkTypeResponse({ ...workType, versions: [] })).toThrow('has no version');
  });
});

describe('ItemsService', () => {
  it('lists a work type\'s items across its versions, scoped by teamId, newest first', async () => {
    const { db, client } = fakeDb();
    expect(await new ItemsService(db).listForWorkType('team-a', 'wt')).toMatchObject({ items: [{ id: 'i1', events: [{ seq: 1 }] }], nextCursor: null });
    // One more than a page is read, to learn whether there is a next page.
    expect(client.item.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { teamId: 'team-a', workTypeVersion: { workTypeId: 'wt' } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 101 }));
  });

  // GWP#54: a status filter is a WHERE beside the cursor.
  it('a status filters the page, and its cursor reads after its last item within the same status', async () => {
    const { db, client } = fakeDb();
    const cursor = Buffer.from(JSON.stringify(['2026-10-01T00:00:02.000Z', '00000000-0000-4000-8000-00000000000b'])).toString('base64url');
    await new ItemsService(db).listForWorkType('team-a', 'wt', { status: 'failed', cursor });
    const after = new Date(Date.UTC(2026, 9, 1, 0, 0, 2));
    expect(client.item.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { teamId: 'team-a', workTypeVersion: { workTypeId: 'wt' }, status: 'failed', OR: [{ createdAt: { lt: after } }, { createdAt: after, id: { lt: '00000000-0000-4000-8000-00000000000b' } }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 101,
    }));
  });

  // GWP#21: the list pages on (createdAt, id) with an opaque cursor.
  it('a full page answers a cursor for the next, which reads after its last item; a cursor it did not give out is 400', async () => {
    const { db, client } = fakeDb();
    const items = new ItemsService(db);
    const [a, b, c] = ['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c'];
    const row = (id: string, second: number) => ({ ...item, id, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, second)), events: [] });
    client.item.findMany.mockResolvedValueOnce([row(c, 3), row(b, 2), row(a, 2)]);
    const first = await items.listForWorkType('team-a', 'wt', { limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual([c, b]);
    expect(first.nextCursor).toEqual(expect.any(String));
    await items.listForWorkType('team-a', 'wt', { cursor: first.nextCursor as string, limit: 2 });
    const after = new Date(Date.UTC(2026, 9, 1, 0, 0, 2));
    expect(client.item.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { teamId: 'team-a', workTypeVersion: { workTypeId: 'wt' }, OR: [{ createdAt: { lt: after } }, { createdAt: after, id: { lt: b } }] }, take: 3,
    }));
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const bad of ['%%%', 'bm9wZQ', encode(['2026-10-01', b]), encode(['2026-10-01T00:00:02.000Z', '']), encode(['2026-10-01T00:00:02.000Z', 'b']), encode(['2026-10-01T00:00:02.000Z']), encode({}),
      encode(['0000-01-01T00:00:00.000Z', b]), encode(['-271821-04-20T00:00:00.000Z', b]), encode(['2026-02-30T00:00:00.000Z', b])]) {
      await expect(items.listForWorkType('team-a', 'wt', { cursor: bad }), bad).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('creates an item with its item.created event only on the team\'s own version', async () => {
    const { db, client } = fakeDb();
    const items = new ItemsService(db);
    expect(await items.create('team-a', { workTypeVersionId: 'v1', data: { title: 'x' } }, 'alice')).toMatchObject({ id: 'i1', events: [{ seq: 1, type: 'item.created' }] });
    expect(client.workTypeVersion.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'v1', teamId: 'team-a' } }));
    expect(client.itemEvent.create).toHaveBeenCalledWith({ data: { itemId: 'i1', seq: 1, type: 'item.created', actorSubject: 'alice', payload: { workTypeVersionId: 'v1' } } });
    client.workTypeVersion.findFirst.mockResolvedValueOnce(null);
    await expect(items.create('team-b', { workTypeVersionId: 'v1', data: {} }, 'bob')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('get is scoped by teamId: another team\'s item is not found', async () => {
    const { db, client } = fakeDb();
    const items = new ItemsService(db);
    expect(await items.get('team-a', 'i1')).toMatchObject({ events: [{ seq: 1 }], steps: definition().steps });
    client.item.findFirst.mockResolvedValueOnce(null);
    await expect(items.get('team-b', 'i1')).rejects.toBeInstanceOf(NotFoundException);
    expect(client.item.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: 'i1', teamId: 'team-b' } }));
  });
});

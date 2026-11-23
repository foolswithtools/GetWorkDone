import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient } from '../src/index.js';

// The two rules Prisma cannot express, enforced by triggers in the domain migration: the audit trail
// is append-only, and a work type version never changes once written.
describe('database triggers', () => {
  const db = createPrismaClient();
  let itemId: string;
  let versionId: string;
  let workTypeKey: { teamId: string; workTypeId: string };

  beforeAll(async () => {
    const team = await db.team.create({ data: { name: 'Triggers' } });
    const workType = await db.workType.create({ data: { teamId: team.id, slug: `t-${team.id}` } });
    const version = await db.workTypeVersion.create({ data: { teamId: team.id, workTypeId: workType.id, version: 1, definition: { v: 1 } } });
    const item = await db.item.create({ data: { teamId: team.id, workTypeVersionId: version.id, data: {} } });
    await db.itemEvent.create({ data: { itemId: item.id, seq: 1, type: 'item.created', payload: {} } });
    itemId = item.id;
    versionId = version.id;
    workTypeKey = { teamId: team.id, workTypeId: workType.id };
  });
  afterAll(() => db.$disconnect());

  it('an UPDATE on ItemEvent raises the append-only error', async () => {
    await expect(db.$executeRaw`UPDATE "ItemEvent" SET "type" = 'tampered' WHERE "itemId" = ${itemId}`).rejects.toThrow(/ItemEvent is append-only/);
    await expect(db.itemEvent.updateMany({ where: { itemId }, data: { type: 'tampered' } })).rejects.toThrow(/ItemEvent is append-only/);
  });

  it('a DELETE on ItemEvent raises the append-only error', async () => {
    await expect(db.$executeRaw`DELETE FROM "ItemEvent" WHERE "itemId" = ${itemId}`).rejects.toThrow(/ItemEvent is append-only/);
    expect(await db.itemEvent.count({ where: { itemId } })).toBe(1);
  });

  it('TRUNCATE on ItemEvent raises the append-only error', async () => {
    await expect(db.$executeRawUnsafe('TRUNCATE "ItemEvent" CASCADE')).rejects.toThrow(/ItemEvent is append-only/);
  });

  it('an UPDATE on WorkTypeVersion raises the immutable error', async () => {
    await expect(db.workTypeVersion.update({ where: { id: versionId }, data: { definition: { v: 2 } } })).rejects.toThrow(/WorkTypeVersion is immutable/);
    expect((await db.workTypeVersion.findUniqueOrThrow({ where: { id: versionId } })).definition).toEqual({ v: 1 });
  });

  it('a DELETE on WorkTypeVersion raises the immutable error, even for a version no item uses', async () => {
    const unused = await db.workTypeVersion.create({ data: { ...workTypeKey, version: 2, definition: { v: 2 } } });
    await expect(db.$executeRaw`DELETE FROM "WorkTypeVersion" WHERE "id" = ${unused.id}`).rejects.toThrow(/WorkTypeVersion is immutable/);
    expect(await db.workTypeVersion.count({ where: { id: unused.id } })).toBe(1);
  });

  it('an item cannot point at another team\'s work type version (composite foreign key)', async () => {
    const other = await db.team.create({ data: { name: 'Other' } });
    await expect(db.item.create({ data: { teamId: other.id, workTypeVersionId: versionId, data: {} } })).rejects.toThrow();
  });
});

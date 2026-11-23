import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ItemDetailResponse, ItemPage, ItemResponse, ItemStatus, TeamRole, WorkTypeDefinition } from '@getworkdone/contracts';
import type { Item, ItemEvent, Prisma } from '@getworkdone/db';
import { Database } from '../database/database.js';

export interface CreateItem {
  workTypeVersionId: string;
  /** The captured values; the capture service (GWP#4) validates them against the version's fields first. */
  data: Record<string, unknown>;
}

export function toItemResponse(item: Item & { events: ItemEvent[] }): ItemResponse {
  return {
    id: item.id, teamId: item.teamId, workTypeVersionId: item.workTypeVersionId, data: item.data as Record<string, unknown>,
    status: item.status, currentStepIndex: item.currentStepIndex, rowVersion: item.rowVersion,
    createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString(),
    events: item.events.map((e) => ({ seq: e.seq, type: e.type, actorSubject: e.actorSubject, at: e.at.toISOString(), payload: e.payload })),
  };
}

/**
 * An item with the steps and fields of the version it was captured under (GWP#5, GWP#23): what the item
 * view shows, and the form an admin edits its data in.
 */
export function toItemDetailResponse(item: Item & { events: ItemEvent[]; workTypeVersion: { definition: unknown } }): ItemDetailResponse {
  // Validated when the version was written and never changed since (work-types.service.ts).
  const definition = item.workTypeVersion.definition as WorkTypeDefinition;
  return { ...toItemResponse(item), steps: definition.steps, fields: definition.fields };
}

/** The most items one page of a work type's list holds. */
export const ITEM_PAGE_SIZE = 100;

interface ItemCursor { createdAt: Date; id: string }

/** Which page of a work type's items to read (GWP#21, GWP#54). */
export interface ItemListQuery {
  /** A previous page's `nextCursor`: read after its last item. */
  cursor?: string;
  /** Only items in this status; the cursor of a filtered page continues the filtered list. */
  status?: ItemStatus;
  /** The most items on the page. */
  limit?: number;
}

/** An opaque cursor: the last listed item's (createdAt, id), the list's order, as base64url JSON. */
function encodeCursor(item: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify([item.createdAt.toISOString(), item.id])).toString('base64url');
}

// What encodeCursor writes: a four-digit year from 0001 (Postgres refuses year 0 and the extended
// years toISOString can write) and an item id, which is a UUID (Postgres refuses a NUL in text).
const CURSOR_TIME = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A cursor encodeCursor gave out; anything else is a 400, never a value the database refuses. */
function decodeCursor(cursor: string): ItemCursor {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    decoded = undefined;
  }
  if (Array.isArray(decoded) && decoded.length === 2 && typeof decoded[0] === 'string' && typeof decoded[1] === 'string' && CURSOR_TIME.test(decoded[0]) && CURSOR_ID.test(decoded[1])) {
    const createdAt = new Date(decoded[0]);
    if (!Number.isNaN(createdAt.getTime()) && createdAt.toISOString() === decoded[0]) return { createdAt, id: decoded[1] };
  }
  throw new BadRequestException('Invalid cursor');
}

const WITH_EVENTS_AND_STEPS = { events: { orderBy: { seq: 'asc' } }, workTypeVersion: { select: { definition: true } } } as const;

/** Items and their audit trail. Every query is scoped by teamId: another team's item is not found. */
@Injectable()
export class ItemsService {
  constructor(private readonly db: Database) {}

  /**
   * A new open item on a version of the team's own work type, with its first event: `item.created`, or
   * `captured` when it comes from the capture form (GWP#4).
   */
  async create(teamId: string, request: CreateItem, actorSubject: string | null, eventType: 'item.created' | 'captured' = 'item.created'): Promise<ItemResponse> {
    const version = await this.db.client.workTypeVersion.findFirst({ where: { id: request.workTypeVersionId, teamId }, select: { id: true } });
    if (!version) throw new NotFoundException('Work type version not found');
    const item = await this.db.client.$transaction(async (tx) => {
      const created = await tx.item.create({ data: { teamId, workTypeVersionId: version.id, data: request.data as Prisma.InputJsonObject } });
      const event = await tx.itemEvent.create({ data: { itemId: created.id, seq: 1, type: eventType, actorSubject, payload: { workTypeVersionId: version.id } } });
      return { ...created, events: [event] };
    });
    return toItemResponse(item);
  }

  /**
   * A page of a work type's items across all its versions, newest first (GWP#21): at most `limit`, after
   * `cursor` when given, only those in `status` when given (GWP#54). Keyed on (createdAt, id), the order
   * itself, so rows sharing a timestamp are each listed once; the status is a WHERE beside it, so a
   * filtered page's cursor continues the filtered list (index Item(teamId, status, createdAt, id)).
   */
  async listForWorkType(teamId: string, workTypeId: string, { cursor, status, limit = ITEM_PAGE_SIZE }: ItemListQuery = {}): Promise<ItemPage> {
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    const items = await this.db.client.item.findMany({
      where: {
        teamId, workTypeVersion: { workTypeId }, ...(status ? { status } : {}),
        ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
      },
      include: { events: { orderBy: { seq: 'asc' } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = items.slice(0, limit);
    const last = page.at(-1);
    return { items: page.map(toItemResponse), nextCursor: items.length > limit && last ? encodeCursor(last) : null };
  }

  /**
   * A page of the waiting-for-me queue (GWP#55): the team's `in_progress` items waiting at a human step
   * whose assigneeRole `subject` holds in the team (an admin holds `admin` and `member`), across every work
   * type, newest first, paged and filtered as listForWorkType is. A WHERE on Item.waitingRole, which each
   * transition keeps (process.service.ts), beside the cursor (index Item(teamId, waitingRole, createdAt, id)).
   */
  async listWaiting(teamId: string, subject: string, { cursor, status, limit = ITEM_PAGE_SIZE }: ItemListQuery = {}): Promise<ItemPage> {
    const after = cursor === undefined ? undefined : decodeCursor(cursor);
    const member = await this.db.client.teamMember.findUnique({ where: { teamId_subject: { teamId, subject } }, select: { role: true } });
    // The team guard has already refused a non-member; a membership removed since lists nothing.
    const roles: TeamRole[] = member?.role === 'admin' ? ['admin', 'member'] : member ? ['member'] : [];
    const items = await this.db.client.item.findMany({
      where: {
        teamId, waitingRole: { in: roles }, status: 'in_progress', ...(status ? { AND: [{ status }] } : {}),
        ...(after ? { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] } : {}),
      },
      include: { events: { orderBy: { seq: 'asc' } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = items.slice(0, limit);
    const last = page.at(-1);
    return { items: page.map(toItemResponse), nextCursor: items.length > limit && last ? encodeCursor(last) : null };
  }

  /** One item, its audit trail and its version's steps. */
  async get(teamId: string, itemId: string): Promise<ItemDetailResponse> {
    const item = await this.db.client.item.findFirst({ where: { id: itemId, teamId }, include: WITH_EVENTS_AND_STEPS });
    if (!item) throw new NotFoundException('Item not found');
    return toItemDetailResponse(item);
  }
}

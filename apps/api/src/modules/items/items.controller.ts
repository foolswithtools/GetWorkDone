import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ItemStatus, type ItemDetailResponse, type ItemPage } from '@getworkdone/contracts';
import { CurrentIdentity, type Identity } from '../../common/identity.js';
import { ItemsService } from './items.service.js';

// Members of the team only (team-member.guard.ts).
@Controller('api/v1/teams/:teamId/items')
export class ItemsController {
  constructor(private readonly items: ItemsService) {}

  /**
   * The waiting-for-me queue (GWP#55): `?waiting=me` is required, as there is no team-wide list of every
   * item; `?cursor=` is the previous page's `nextCursor` and `?status=` narrows it as on a work type's list.
   */
  @Get()
  listWaiting(@Param('teamId') teamId: string, @CurrentIdentity() identity: Identity, @Query('waiting') waiting?: unknown, @Query('cursor') cursor?: unknown, @Query('status') status?: unknown): Promise<ItemPage> {
    // A repeated parameter arrives as an array.
    if (waiting !== 'me') throw new BadRequestException('List the items waiting for you with ?waiting=me');
    if (cursor !== undefined && typeof cursor !== 'string') throw new BadRequestException('Invalid cursor');
    const parsed = status === undefined ? undefined : ItemStatus.safeParse(status);
    if (parsed && !parsed.success) throw new BadRequestException('Invalid status');
    return this.items.listWaiting(teamId, identity.subject, { cursor, status: parsed?.data });
  }

  @Get(':itemId')
  get(@Param('teamId') teamId: string, @Param('itemId') itemId: string): Promise<ItemDetailResponse> {
    return this.items.get(teamId, itemId);
  }
}

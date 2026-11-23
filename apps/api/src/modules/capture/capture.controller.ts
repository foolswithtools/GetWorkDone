import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { CreateItemRequest, CreateWorkTypeVersionRequest, ItemStatus, type ItemDetailResponse, type ItemPage, type WorkTypeResponse } from '@getworkdone/contracts';
import { CurrentIdentity, type Identity } from '../../common/identity.js';
import { TakeQuota } from '../../common/quota.js';
import { RequireTeamRole } from '../../common/team-member.guard.js';
import { parseBody, parseDefinitionBody } from '../../common/zod.js';
import { CaptureService } from './capture.service.js';

// Members of the team only (team-member.guard.ts); a new version needs the team admin role. RED comes
// from the global interceptor; the submit runs inside the capture.submit span (capture.service.ts).
@Controller('api/v1/teams/:teamId/work-types/:workTypeId')
export class CaptureController {
  constructor(private readonly capture: CaptureService) {}

  @Post('versions')
  @HttpCode(201)
  @RequireTeamRole('admin')
  addVersion(@Param('teamId') teamId: string, @Param('workTypeId') workTypeId: string, @Body() body: unknown): Promise<WorkTypeResponse> {
    return this.capture.addVersion(teamId, workTypeId, parseDefinitionBody(CreateWorkTypeVersionRequest, body));
  }

  /** 429 with Retry-After past the subject's items a minute, on any team (GWP#50), before the body is read. */
  @Post('items')
  @HttpCode(201)
  @TakeQuota('items')
  submit(@Param('teamId') teamId: string, @Param('workTypeId') workTypeId: string, @CurrentIdentity() identity: Identity, @Body() body: unknown): Promise<ItemDetailResponse> {
    return this.capture.submit(teamId, workTypeId, parseBody(CreateItemRequest, body), identity.subject);
  }

  /**
   * One page of items; `?cursor=` is the previous page's `nextCursor` (GWP#21), and `?status=` one item
   * status to list only those (GWP#54), which the cursor of a filtered page stays within.
   */
  @Get('items')
  list(@Param('teamId') teamId: string, @Param('workTypeId') workTypeId: string, @Query('cursor') cursor?: unknown, @Query('status') status?: unknown): Promise<ItemPage> {
    // A repeated ?cursor= or ?status= arrives as an array.
    if (cursor !== undefined && typeof cursor !== 'string') throw new BadRequestException('Invalid cursor');
    const parsed = status === undefined ? undefined : ItemStatus.safeParse(status);
    if (parsed && !parsed.success) throw new BadRequestException('Invalid status');
    return this.capture.list(teamId, workTypeId, cursor, parsed?.data);
  }
}

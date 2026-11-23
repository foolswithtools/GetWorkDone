import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { CancelItemRequest, CompleteStepRequest, EditItemDataRequest, StepTransitionRequest, type ItemDetailResponse } from '@getworkdone/contracts';
import { CurrentIdentity, type Identity } from '../../common/identity.js';
import { RequireTeamRole } from '../../common/team-member.guard.js';
import { parseBody } from '../../common/zod.js';
import { ProcessService } from './process.service.js';

// Members of the team only (team-member.guard.ts); a human step also needs its assigneeRole, checked
// by the service, and a retry, a resume (GWP#22), a data edit (GWP#23) or a cancel (GWP#54) needs the team admin role. Each transition runs
// inside a process.step span (process.service.ts); RED comes from the global interceptor.
@Controller('api/v1/teams/:teamId/items/:itemId')
export class ProcessController {
  constructor(private readonly process: ProcessService) {}

  @Post('steps/:stepId/complete')
  @HttpCode(200)
  complete(@Param('teamId') teamId: string, @Param('itemId') itemId: string, @Param('stepId') stepId: string, @CurrentIdentity() identity: Identity, @Body() body: unknown): Promise<ItemDetailResponse> {
    const { rowVersion, ...completion } = parseBody(CompleteStepRequest, body);
    return this.process.completeStep(teamId, itemId, stepId, rowVersion, identity.subject, completion);
  }

  @Post('steps/:stepId/retry')
  @HttpCode(200)
  @RequireTeamRole('admin')
  retry(@Param('teamId') teamId: string, @Param('itemId') itemId: string, @Param('stepId') stepId: string, @CurrentIdentity() identity: Identity, @Body() body: unknown): Promise<ItemDetailResponse> {
    return this.process.retry(teamId, itemId, stepId, parseBody(StepTransitionRequest, body).rowVersion, identity.subject);
  }

  @Post('advance')
  @HttpCode(200)
  @RequireTeamRole('admin')
  advance(@Param('teamId') teamId: string, @Param('itemId') itemId: string, @CurrentIdentity() identity: Identity, @Body() body: unknown): Promise<ItemDetailResponse> {
    return this.process.resume(teamId, itemId, parseBody(StepTransitionRequest, body).rowVersion, identity.subject);
  }

  @Post('data')
  @HttpCode(200)
  @RequireTeamRole('admin')
  editData(@Param('teamId') teamId: string, @Param('itemId') itemId: string, @CurrentIdentity() identity: Identity, @Body() body: unknown): Promise<ItemDetailResponse> {
    const { rowVersion, data } = parseBody(EditItemDataRequest, body);
    return this.process.editData(teamId, itemId, rowVersion, data, identity.subject);
  }

  @Post('cancel')
  @HttpCode(200)
  @RequireTeamRole('admin')
  cancel(@Param('teamId') teamId: string, @Param('itemId') itemId: string, @CurrentIdentity() identity: Identity, @Body() body: unknown): Promise<ItemDetailResponse> {
    const { rowVersion, reason } = parseBody(CancelItemRequest, body);
    return this.process.cancel(teamId, itemId, rowVersion, reason, identity.subject);
  }
}

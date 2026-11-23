import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ArchiveWorkTypeRequest, CreateWorkTypeRequest, type WorkTypeResponse } from '@getworkdone/contracts';
import { RequireTeamRole } from '../../common/team-member.guard.js';
import { parseBody, parseDefinitionBody } from '../../common/zod.js';
import { WorkTypesService } from './work-types.service.js';

// Members of the team only (team-member.guard.ts); writes need the team admin role.
@Controller('api/v1/teams/:teamId/work-types')
export class WorkTypesController {
  constructor(private readonly workTypes: WorkTypesService) {}

  /** The team's work types; archived ones too with `?includeArchived=true` (GWP#55). */
  @Get()
  list(@Param('teamId') teamId: string, @Query('includeArchived') includeArchived?: unknown): Promise<WorkTypeResponse[]> {
    if (includeArchived !== undefined && includeArchived !== 'true' && includeArchived !== 'false') throw new BadRequestException('includeArchived must be true or false');
    return this.workTypes.list(teamId, { includeArchived: includeArchived === 'true' });
  }

  /** An invalid body is 422 `{ errors }` keyed by path, as on POST .../versions (capture.controller.ts). */
  @Post()
  @RequireTeamRole('admin')
  create(@Param('teamId') teamId: string, @Body() body: unknown): Promise<WorkTypeResponse> {
    return this.workTypes.create(teamId, parseDefinitionBody(CreateWorkTypeRequest, body));
  }

  /** GWP#55: retires the work type; body `{}`. */
  @Post(':workTypeId/archive')
  @HttpCode(200)
  @RequireTeamRole('admin')
  archive(@Param('teamId') teamId: string, @Param('workTypeId') workTypeId: string, @Body() body: unknown): Promise<WorkTypeResponse> {
    parseBody(ArchiveWorkTypeRequest, body);
    return this.workTypes.setArchived(teamId, workTypeId, true);
  }

  @Post(':workTypeId/unarchive')
  @HttpCode(200)
  @RequireTeamRole('admin')
  unarchive(@Param('teamId') teamId: string, @Param('workTypeId') workTypeId: string, @Body() body: unknown): Promise<WorkTypeResponse> {
    parseBody(ArchiveWorkTypeRequest, body);
    return this.workTypes.setArchived(teamId, workTypeId, false);
  }
}

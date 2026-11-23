import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { AddTeamMemberRequest, type TeamMemberResponse } from '@getworkdone/contracts';
import { RequireTeamRole } from '../../common/team-member.guard.js';
import { parseBody } from '../../common/zod.js';
import { TeamsService } from './teams.service.js';

/**
 * A team's members (GWP#20, docs/auth.md "Team membership"). Every route is for the team's admins; the
 * team-member guard answers anyone else 403 before the handler runs.
 */
@Controller('api/v1/teams/:teamId/members')
@RequireTeamRole('admin')
export class MembersController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  list(@Param('teamId') teamId: string): Promise<TeamMemberResponse[]> {
    return this.teams.listMembers(teamId);
  }

  @Post()
  @HttpCode(201)
  add(@Param('teamId') teamId: string, @Body() body: unknown): Promise<TeamMemberResponse> {
    return this.teams.addMember(teamId, parseBody(AddTeamMemberRequest, body));
  }

  @Delete(':subject')
  @HttpCode(204)
  async remove(@Param('teamId') teamId: string, @Param('subject') subject: string): Promise<void> {
    await this.teams.removeMember(teamId, subject);
  }
}

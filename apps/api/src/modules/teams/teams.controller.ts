import { Body, Controller, Get, Post } from '@nestjs/common';
import { CreateTeamRequest, type TeamResponse } from '@getworkdone/contracts';
import { CurrentIdentity, type Identity } from '../../common/identity.js';
import { TakeQuota } from '../../common/quota.js';
import { parseBody } from '../../common/zod.js';
import { TeamsService } from './teams.service.js';

@Controller('api/v1/teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  list(@CurrentIdentity() identity: Identity): Promise<TeamResponse[]> {
    return this.teams.listForSubject(identity.subject);
  }

  /** 429 with Retry-After past the subject's teams a day (GWP#50), before the body is read. */
  @Post()
  @TakeQuota('teams')
  create(@CurrentIdentity() identity: Identity, @Body() body: unknown): Promise<TeamResponse> {
    return this.teams.create(identity.subject, parseBody(CreateTeamRequest, body));
  }
}

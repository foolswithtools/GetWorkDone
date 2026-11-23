// Team authorization (GWP#3): every /api/v1 route with a :teamId parameter (/api/v1/teams/:teamId/*)
// needs a TeamMember row for the signed-in subject, or it is 403, before the handler reads anything; a
// team that does not exist is 403 the same way. A handler or controller marked @RequireTeamRole('admin')
// (the work-type writes, the members routes) needs the admin role too. It is a global guard, after authentication and CSRF
// (common.module.ts), so a team route added later is covered without opting in.

import { ForbiddenException, Injectable, SetMetadata, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TeamRole } from '@getworkdone/contracts';
import type { Request } from 'express';
import { Database } from '../modules/database/database.js';
import { isProtectedPath } from './deny-by-default.guard.js';
import { identityOf } from './identity.js';

const TEAM_ROLE = Symbol('team-role');

/** The team role a handler needs; without it, membership (any role) is enough. */
export const RequireTeamRole = (role: TeamRole) => SetMetadata(TEAM_ROLE, role);

@Injectable()
export class TeamMemberGuard implements CanActivate {
  constructor(private readonly db: Database, private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const teamId = (req.params as Record<string, unknown> | undefined)?.teamId;
    if (!isProtectedPath(req.path) || typeof teamId !== 'string') return true;
    const identity = identityOf(req);
    if (!identity) throw new UnauthorizedException();
    const member = await this.db.client.teamMember.findUnique({ where: { teamId_subject: { teamId, subject: identity.subject } }, select: { role: true } });
    if (!member) throw new ForbiddenException('Not a member of this team');
    const required = this.reflector.getAllAndOverride<TeamRole | undefined>(TEAM_ROLE, [context.getHandler(), context.getClass()]);
    if (required === 'admin' && member.role !== 'admin') throw new ForbiddenException('This needs the team admin role');
    return true;
  }
}

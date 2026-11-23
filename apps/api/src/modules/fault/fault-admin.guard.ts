// Who may set a fault (GWP#9): a subject in FAULT_ADMIN_SUBJECTS, else 403. A route guard, so it runs after
// the global guards (deny by default, then CSRF). @RequireTeamRole cannot protect /api/v1/__fault, which
// has no :teamId (team-member.guard.ts), and any signed-in user becomes a team admin by creating a team.
// The list is kept apart from SYNTHETIC_SUBJECTS: the drill's 500s must spend the error budget, and the
// k6 smoke's user must not be able to inject faults.

import { ForbiddenException, Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { requireIdentity } from '../../common/identity.js';
import { FAULT_OPTIONS, type FaultOptions } from './fault.state.js';

@Injectable()
export class FaultAdminGuard implements CanActivate {
  constructor(@Inject(FAULT_OPTIONS) private readonly options: FaultOptions) {}

  canActivate(context: ExecutionContext): boolean {
    const identity = requireIdentity(context.switchToHttp().getRequest<Request>());
    if (!this.options.adminSubjects.has(identity.subject)) throw new ForbiddenException('Only a subject in FAULT_ADMIN_SUBJECTS may set a fault');
    return true;
  }
}

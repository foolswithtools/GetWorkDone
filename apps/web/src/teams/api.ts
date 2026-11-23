// The SPA's calls to the team routes: creating a team (GWP#49; the caller becomes its admin) and the team
// member routes (GWP#20, docs/auth.md "Team membership"; admins only). A malformed name is a 400 whose
// issues are keyed `name`; a refused add or remove (409 for a subject already in the team or for the last
// admin) and a 403 without the CSRF token are form-level errors.

import type { AddTeamMemberRequest, TeamMemberResponse, TeamResponse } from '@getworkdone/contracts';
import { read, remove, write, type WriteResult } from '../work-types/api.js';

export function createTeam(name: string, csrfToken: string, fetchImpl: typeof fetch = fetch): Promise<WriteResult<TeamResponse>> {
  return write('/api/v1/teams', { name }, csrfToken, fetchImpl);
}

const membersPath = (teamId: string) => `/api/v1/teams/${encodeURIComponent(teamId)}/members`;

export function listMembers(teamId: string, fetchImpl: typeof fetch = fetch): Promise<TeamMemberResponse[]> {
  return read(membersPath(teamId), fetchImpl);
}

export function addMember(teamId: string, member: AddTeamMemberRequest, csrfToken: string, fetchImpl: typeof fetch = fetch): Promise<WriteResult<TeamMemberResponse>> {
  return write(membersPath(teamId), member, csrfToken, fetchImpl);
}

export function removeMember(teamId: string, subject: string, csrfToken: string, fetchImpl: typeof fetch = fetch): Promise<WriteResult<undefined>> {
  return remove(`${membersPath(teamId)}/${encodeURIComponent(subject)}`, csrfToken, fetchImpl);
}

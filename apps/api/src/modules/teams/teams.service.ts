import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AddTeamMemberRequest, CreateTeamRequest, TeamMemberResponse, TeamResponse } from '@getworkdone/contracts';
import { Prisma, type Identity, type Team, type TeamMember } from '@getworkdone/db';
import { Database } from '../database/database.js';

// Removing a member waits on the team's row lock (GWP#20), `FOR NO KEY UPDATE` as in exports.service.ts,
// so it does not block inserts that reference the team. READ COMMITTED is pinned because the last-admin
// rule rests on it: after the lock, the admin count sees a removal the lock holder committed.
const TRANSACTION = { maxWait: 10_000, timeout: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };

export function toTeamResponse(team: Team): TeamResponse {
  return { id: team.id, name: team.name, createdAt: team.createdAt.toISOString() };
}

/** A member with the email and display name of their last sign-in (GWP#99), or null for both if they have not signed in. */
function toTeamMemberResponse(member: TeamMember, identity: Pick<Identity, 'email' | 'displayName'> | undefined): TeamMemberResponse {
  return {
    subject: member.subject, role: member.role, createdAt: member.createdAt.toISOString(),
    email: identity?.email ?? null, displayName: identity?.displayName ?? null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class TeamsService {
  constructor(private readonly db: Database) {}

  /** A new team, with its creator as its first admin. */
  async create(subject: string, request: CreateTeamRequest): Promise<TeamResponse> {
    const team = await this.db.client.team.create({ data: { name: request.name, members: { create: { subject, role: 'admin' } } } });
    return toTeamResponse(team);
  }

  /** The teams `subject` is a member of, oldest first. */
  async listForSubject(subject: string): Promise<TeamResponse[]> {
    const teams = await this.db.client.team.findMany({ where: { members: { some: { subject } } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return teams.map(toTeamResponse);
  }

  /** Throws NotFoundException unless the team exists. */
  async requireTeam(teamId: string): Promise<void> {
    const team = await this.db.client.team.findUnique({ where: { id: teamId }, select: { id: true } });
    if (!team) throw new NotFoundException('Team not found');
  }

  /**
   * The team's members, oldest first (GWP#20), each with their Identity's email and display name, or null
   * for both (GWP#99). Identity has no relation to TeamMember, so the left join is a second query by subject.
   */
  async listMembers(teamId: string): Promise<TeamMemberResponse[]> {
    const members = await this.db.client.teamMember.findMany({ where: { teamId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const profiles = await this.profiles(members.map((m) => m.subject));
    return members.map((m) => toTeamMemberResponse(m, profiles.get(m.subject)));
  }

  /** Adds `subject` to the team; a subject already in it is a conflict, whatever its role (GWP#20). */
  async addMember(teamId: string, request: AddTeamMemberRequest): Promise<TeamMemberResponse> {
    let member: TeamMember;
    try {
      member = await this.db.client.teamMember.create({ data: { teamId, subject: request.subject, role: request.role } });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(`${request.subject} is already a member of this team`);
      throw error;
    }
    return toTeamMemberResponse(member, (await this.profiles([member.subject])).get(member.subject));
  }

  /** The Identity of each subject that has signed in, by subject. */
  private async profiles(subjects: string[]): Promise<Map<string, Pick<Identity, 'email' | 'displayName'>>> {
    if (subjects.length === 0) return new Map();
    const rows = await this.db.client.identity.findMany({ where: { subject: { in: subjects } }, select: { subject: true, email: true, displayName: true } });
    return new Map(rows.map((r) => [r.subject, r]));
  }

  /**
   * Removes `subject` from the team (GWP#20): not found unless it is a member, and a conflict when it is
   * the team's last admin, so a team always keeps one. The check and the delete hold the team's row lock,
   * so two admins removing each other at once cannot both succeed.
   */
  async removeMember(teamId: string, subject: string): Promise<void> {
    await this.db.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Team" WHERE id = ${teamId} FOR NO KEY UPDATE`;
      const member = await tx.teamMember.findUnique({ where: { teamId_subject: { teamId, subject } }, select: { role: true } });
      if (!member) throw new NotFoundException('Not a member of this team');
      if (member.role === 'admin' && await tx.teamMember.count({ where: { teamId, role: 'admin' } }) <= 1) {
        throw new ConflictException('A team needs an admin: add another admin before removing this one');
      }
      await tx.teamMember.delete({ where: { teamId_subject: { teamId, subject } } });
    }, TRANSACTION);
  }
}

import { randomBytes } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { outputProblems, stepProblems, type CreateWorkTypeRequest, type WorkTypeDefinition, type WorkTypeResponse } from '@getworkdone/contracts';
import { Prisma, type WorkType, type WorkTypeVersion } from '@getworkdone/db';
import { QuotaLimiter } from '../../common/quota.js';
import { Database } from '../database/database.js';
import { TRANSFORMS } from '../process/transforms.js';
import { TeamsService } from '../teams/teams.service.js';

// The cap's count rests on READ COMMITTED: after the team's row lock, it sees a work type the lock holder committed.
const TRANSACTION = { maxWait: 10_000, timeout: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };

const LATEST_VERSION = { versions: { orderBy: { version: 'desc' }, take: 1 } } as const;

export function toWorkTypeResponse(workType: WorkType & { versions: WorkTypeVersion[] }): WorkTypeResponse {
  const [version] = workType.versions;
  if (!version) throw new Error(`work type ${workType.id} has no version`);
  return {
    id: workType.id, teamId: workType.teamId, slug: workType.slug, createdAt: workType.createdAt.toISOString(),
    archivedAt: workType.archivedAt?.toISOString() ?? null,
    // Validated when written (checkDefinition, after the route's parse) and never changed since; not re-parsed here, so a
    // stricter contract later cannot turn an old version into a 500.
    version: { id: version.id, version: version.version, definition: version.definition as WorkTypeDefinition, createdAt: version.createdAt.toISOString() },
  };
}

/**
 * A definition arrives parsed: each route parses its body once with the contract and answers a refusal
 * 422 `{ errors }` keyed by path (common/zod.ts, GWP#21); the stored JSON is the parsed value, defaults
 * filled in. Its automated steps are then checked against the transform registry (GWP#5,
 * docs/process.md): an unknown transform, bad params or a param naming a missing field is 422 `{ errors }`.
 * Its outputs are checked the same way (GWP#6, docs/outputs.md): ids and each kind's config.
 */
function checkDefinition(definition: WorkTypeDefinition): WorkTypeDefinition {
  const problems = Object.entries({ ...stepProblems(definition, TRANSFORMS), ...outputProblems(definition) });
  if (problems.length > 0) throw new UnprocessableEntityException({ errors: Object.fromEntries(problems.map(([path, messages]) => [`definition.${path}`, messages])) });
  return definition;
}

/** A parsed definition is plain JSON; its optional keys are left out, never set to undefined. */
function asJson(definition: WorkTypeDefinition): Prisma.InputJsonObject {
  return definition as Prisma.InputJsonObject;
}

const webhookIds = (definition: WorkTypeDefinition | undefined) => new Set((definition?.outputs ?? []).filter((o) => o.kind === 'webhook').map((o) => o.id));

/**
 * GWP#6: a new signing secret for each webhook output this save adds, meaning its id was not a webhook in
 * the `previous` version, written with the new version and answered once, in the save's response
 * (`webhookSecrets`). A webhook carried over keeps its secret. An id that comes back after a version
 * without it gets a new one, replacing the old: a re-added webhook is a new receiver, which never saw it.
 */
async function issueWebhookSecrets(tx: Prisma.TransactionClient, teamId: string, workTypeId: string, definition: WorkTypeDefinition, previous?: WorkTypeDefinition): Promise<Record<string, string>> {
  const kept = webhookIds(previous);
  const added = [...webhookIds(definition)].filter((id) => !kept.has(id));
  if (added.length === 0) return {};
  const issued = Object.fromEntries(added.map((id) => [id, randomBytes(32).toString('hex')]));
  await tx.outputSecret.deleteMany({ where: { workTypeId, outputId: { in: added } } });
  await tx.outputSecret.createMany({ data: added.map((outputId) => ({ teamId, workTypeId, outputId, secret: issued[outputId] as string })) });
  return issued;
}

function withSecrets(response: WorkTypeResponse, secrets: Record<string, string>): WorkTypeResponse {
  return Object.keys(secrets).length > 0 ? { ...response, webhookSecrets: secrets } : response;
}

/** GWP#55: the 409 for a capture or a new version while the work type is archived. */
export const ARCHIVED = 'This work type is archived';

/** GWP#50, GWP#103: the 409 for a create or an unarchive past QUOTA_WORK_TYPES_PER_TEAM. */
const capReached = (cap: number) => `This team has reached its limit of ${cap} work types`;

/** GWP#103: only active work types count against the cap; archiving one frees its place. */
const activeCount = (tx: Prisma.TransactionClient, teamId: string) => tx.workType.count({ where: { teamId, archivedAt: null } });

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Work types and their versions. Every query is scoped by teamId: another team's work type is not found.
 * Versions are immutable (a database trigger rejects any UPDATE): a change writes the next version.
 */
@Injectable()
export class WorkTypesService {
  constructor(private readonly db: Database, private readonly teams: TeamsService, private readonly quotas: QuotaLimiter) {}

  /** The team's work types, oldest first; archived ones only with `includeArchived` (GWP#55). */
  async list(teamId: string, { includeArchived = false }: { includeArchived?: boolean } = {}): Promise<WorkTypeResponse[]> {
    await this.teams.requireTeam(teamId);
    const workTypes = await this.db.client.workType.findMany({ where: { teamId, ...(includeArchived ? {} : { archivedAt: null }) }, include: LATEST_VERSION, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return workTypes.map(toWorkTypeResponse);
  }

  /**
   * Archives a work type, or unarchives it (GWP#55): archived, it leaves the list and refuses capture and
   * new versions (409); its items, exports and in-flight processing carry on. Archiving an archived work
   * type keeps its first archivedAt, and unarchiving one that is not archived changes nothing. Unarchiving
   * takes a place under the cap (GWP#103): see unarchive.
   */
  async setArchived(teamId: string, workTypeId: string, archived: boolean): Promise<WorkTypeResponse> {
    const cap = this.quotas.workTypeCap();
    if (!archived && cap !== undefined) return this.unarchive(teamId, workTypeId, cap);
    await this.db.client.workType.updateMany({
      where: { id: workTypeId, teamId, ...(archived ? { archivedAt: null } : {}) },
      data: { archivedAt: archived ? new Date() : null },
    });
    return this.get(teamId, workTypeId);
  }

  /**
   * GWP#103: an unarchive under the cap, under the team's row lock as create's count is, so a create and an
   * unarchive, or two unarchives, cannot both take the last place. Not in the team is 404; already active is
   * a no-op 200 at any count; an archived one with no place left is create's 409 and writes nothing.
   */
  private async unarchive(teamId: string, workTypeId: string, cap: number): Promise<WorkTypeResponse> {
    await this.db.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Team" WHERE id = ${teamId} FOR NO KEY UPDATE`;
      const workType = await tx.workType.findFirst({ where: { id: workTypeId, teamId }, select: { archivedAt: true } });
      if (!workType) throw new NotFoundException('Work type not found');
      if (workType.archivedAt === null) return;
      if (await activeCount(tx, teamId) >= cap) throw new ConflictException(capReached(cap));
      await tx.workType.updateMany({ where: { id: workTypeId, teamId }, data: { archivedAt: null } });
    }, TRANSACTION);
    return this.get(teamId, workTypeId);
  }

  async get(teamId: string, workTypeId: string): Promise<WorkTypeResponse> {
    const workType = await this.db.client.workType.findFirst({ where: { id: workTypeId, teamId }, include: LATEST_VERSION });
    if (!workType) throw new NotFoundException('Work type not found');
    return toWorkTypeResponse(workType);
  }

  /**
   * A new work type and its version 1. A slug the team already uses is a conflict, and so is a team at its
   * cap of active work types (QUOTA_WORK_TYPES_PER_TEAM, GWP#50, GWP#103: archived ones do not count), counted under the team's row lock so two creates
   * at once cannot both take the last place. `FOR NO KEY UPDATE` and READ COMMITTED as in teams.service.ts.
   */
  async create(teamId: string, request: CreateWorkTypeRequest): Promise<WorkTypeResponse> {
    const definition = checkDefinition(request.definition);
    await this.teams.requireTeam(teamId);
    const cap = this.quotas.workTypeCap();
    try {
      const { workType, secrets } = await this.db.client.$transaction(async (tx) => {
        if (cap !== undefined) {
          await tx.$queryRaw`SELECT id FROM "Team" WHERE id = ${teamId} FOR NO KEY UPDATE`;
          if (await activeCount(tx, teamId) >= cap) throw new ConflictException(capReached(cap));
        }
        const created = await tx.workType.create({ data: { teamId, slug: request.slug } });
        const version = await tx.workTypeVersion.create({ data: { teamId, workTypeId: created.id, version: 1, definition: asJson(definition) } });
        return { workType: { ...created, versions: [version] }, secrets: await issueWebhookSecrets(tx, teamId, created.id, definition) };
      }, TRANSACTION);
      return withSecrets(toWorkTypeResponse(workType), secrets);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(`Work type "${request.slug}" already exists in this team`);
      throw error;
    }
  }

  /** Changes a work type's definition by writing the next version; existing versions are never updated. */
  async reviseDefinition(teamId: string, workTypeId: string, definition: WorkTypeDefinition): Promise<WorkTypeResponse> {
    const next = checkDefinition(definition);
    const current = await this.get(teamId, workTypeId);
    if (current.archivedAt !== null) throw new ConflictException(ARCHIVED);
    try {
      const { version, secrets } = await this.db.client.$transaction(async (tx) => ({
        version: await tx.workTypeVersion.create({ data: { teamId, workTypeId, version: current.version.version + 1, definition: asJson(next) } }),
        secrets: await issueWebhookSecrets(tx, teamId, workTypeId, next, current.version.definition),
      }));
      return withSecrets({ ...current, version: { id: version.id, version: version.version, definition: next, createdAt: version.createdAt.toISOString() } }, secrets);
    } catch (error) {
      // Another revision took the same version number first.
      if (isUniqueViolation(error)) throw new ConflictException('The work type changed; read it again and retry');
      throw error;
    }
  }
}

import { HttpException, HttpStatus, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ExportConfig, type CreateExportRequest, type ExportFormat, type ExportResponse, type WorkTypeDefinition } from '@getworkdone/contracts';
import { Prisma, type Export } from '@getworkdone/db';
import { withSpan } from '@getworkdone/telemetry';
import { Database } from '../database/database.js';
import { DISTRIBUTE_RUNTIME, type DistributeRuntime } from './distribute.options.js';
import { ExportBuilder, ExportTooLarge } from './export.adapter.js';

const PAGE = 500;
/** Exports kept per work type (GWP#25): the eleventh deletes the oldest. */
export const KEPT_PER_WORK_TYPE = 10;
/** A team's exports older than this are deleted when it generates another (GWP#25). */
export const KEPT_FOR_MS = 7 * 24 * 60 * 60 * 1000;
/** One export per work type in this long (GWP#25). */
export const EXPORT_INTERVAL_MS = 30 * 1000;
// Storing waits on the team's row lock behind another export's 10 MB insert, so allow more than Prisma's
// 5 s. READ COMMITTED is pinned because the limit rests on it: after the lock, the next read sees the
// export the lock holder committed.
const TRANSACTION = { maxWait: 10_000, timeout: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };

/** 429: the work type was exported less than 30 seconds ago. The controller sends `retryAfterSeconds` as Retry-After. */
export class ExportTooSoon extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super('This work type was exported less than 30 seconds ago; try again shortly', HttpStatus.TOO_MANY_REQUESTS);
  }
}

function toExportResponse(row: Omit<Export, 'content' | 'teamId'>): ExportResponse {
  return {
    id: row.id, workTypeId: row.workTypeId, format: row.format as ExportFormat, itemCount: row.itemCount, sizeBytes: row.sizeBytes,
    createdBySubject: row.createdBySubject, createdAt: row.createdAt.toISOString(),
  };
}

export interface ExportFile {
  content: Buffer;
  format: ExportFormat;
  filename: string;
}

/**
 * Exports (GWP#6, docs/outputs.md): a member asks for a CSV or JSON file of a work type's completed
 * items, across all its versions, oldest first. The work type's latest version must have an `export`
 * output, whose format is the default. The file is built in pages, refused past 10 MB, and stored.
 * Every query is scoped by teamId: another team's work type or export is not found.
 *
 * Stored exports are bounded (GWP#25): one per work type every 30 seconds, at most 10 per work type,
 * and none older than 7 days once the team generates another. Times come from the distribute clock.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly db: Database,
    @Inject(DISTRIBUTE_RUNTIME) private readonly runtime: DistributeRuntime,
  ) {}

  async create(teamId: string, workTypeId: string, request: CreateExportRequest, subject: string): Promise<ExportResponse> {
    const workType = await this.db.client.workType.findFirst({ where: { id: workTypeId, teamId }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
    if (!workType?.versions[0]) throw new NotFoundException('Work type not found');
    // Validated when the version was written and never changed since (work-types.service.ts).
    const definition = workType.versions[0].definition as WorkTypeDefinition;
    const output = definition.outputs.find((o) => o.kind === 'export');
    if (!output) throw new UnprocessableEntityException('This work type has no export output');
    const format = request.format ?? ExportConfig.safeParse(output.config).data?.format ?? 'csv';
    // Refused before the file is built, so a refused request costs no paging; store() checks again under the lock.
    this.refuseTooSoon(await this.latest(this.db.client, teamId, workTypeId), this.runtime.now());
    const built = await withSpan('distribute.export', async (span) => {
      span.setAttributes({ 'output.kind': 'export', 'export.format': format, 'work_type.id': workTypeId });
      const builder = new ExportBuilder(format, definition.fields);
      try {
        let cursor: string | undefined;
        for (;;) {
          const page = await this.db.client.item.findMany({
            where: { teamId, status: 'completed', workTypeVersion: { workTypeId } },
            include: { events: { where: { type: 'completed' }, orderBy: { seq: 'desc' }, take: 1, select: { at: true } } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: PAGE,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          });
          for (const item of page) builder.add({ id: item.id, completedAt: (item.events[0]?.at ?? item.updatedAt).toISOString(), data: item.data as Record<string, unknown> });
          if (page.length < PAGE) break;
          cursor = page[page.length - 1]?.id;
        }
      } catch (error) {
        // Too large is the caller's request, not the span's error: it is answered 422 outside the span.
        if (error instanceof ExportTooLarge) return error;
        throw error;
      }
      const file = builder.finish();
      span.setAttributes({ 'export.items': file.itemCount, 'export.bytes': file.content.length });
      return file;
    });
    if (built instanceof ExportTooLarge) throw new UnprocessableEntityException(built.message);
    const data = { teamId, workTypeId, format, content: new Uint8Array(built.content), sizeBytes: built.content.length, itemCount: built.itemCount, createdBySubject: subject };
    return toExportResponse(await this.db.client.$transaction((tx) => this.store(tx, data), TRANSACTION));
  }

  /**
   * Stores the export and applies the limits in one transaction. The team's row lock orders the team's
   * exports: of two of one work type at once the second sees the first and is refused, and two of
   * different work types cannot deadlock on each other's rows in the team-wide 7-day delete. NO KEY
   * UPDATE, not UPDATE: it does not conflict with the key-share lock every child row's insert takes on
   * its team, so captures and deliveries never wait behind an export.
   */
  private async store(tx: Prisma.TransactionClient, data: Prisma.ExportUncheckedCreateInput): Promise<Omit<Export, 'content'>> {
    const { teamId, workTypeId } = data;
    await tx.$queryRaw`SELECT id FROM "Team" WHERE id = ${teamId} FOR NO KEY UPDATE`;
    const now = this.runtime.now();
    this.refuseTooSoon(await this.latest(tx, teamId, workTypeId), now);
    const row = await tx.export.create({ data: { ...data, createdAt: now }, omit: { content: true } });
    const kept = await tx.export.findMany({ where: { teamId, workTypeId }, select: { id: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: KEPT_PER_WORK_TYPE });
    await tx.export.deleteMany({ where: { teamId, workTypeId, id: { notIn: kept.map((k) => k.id) } } });
    await tx.export.deleteMany({ where: { teamId, createdAt: { lt: new Date(now.getTime() - KEPT_FOR_MS) } } });
    return row;
  }

  private async latest(client: Prisma.TransactionClient, teamId: string, workTypeId: string): Promise<Date | undefined> {
    const row = await client.export.findFirst({ where: { teamId, workTypeId }, select: { createdAt: true }, orderBy: { createdAt: 'desc' } });
    return row?.createdAt;
  }

  private refuseTooSoon(latest: Date | undefined, now: Date): void {
    const wait = latest ? latest.getTime() + EXPORT_INTERVAL_MS - now.getTime() : 0;
    if (wait > 0) throw new ExportTooSoon(Math.ceil(wait / 1000));
  }

  /** The work type's exports (at most 10 are kept), newest first, without their content. */
  async list(teamId: string, workTypeId: string): Promise<ExportResponse[]> {
    const workType = await this.db.client.workType.findFirst({ where: { id: workTypeId, teamId }, select: { id: true } });
    if (!workType) throw new NotFoundException('Work type not found');
    const rows = await this.db.client.export.findMany({ where: { teamId, workTypeId }, omit: { content: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: KEPT_PER_WORK_TYPE });
    return rows.map(toExportResponse);
  }

  async download(teamId: string, exportId: string): Promise<ExportFile> {
    const row = await this.db.client.export.findFirst({ where: { id: exportId, teamId }, include: { workType: { select: { slug: true } } } });
    if (!row) throw new NotFoundException('Export not found');
    const format = row.format as ExportFormat;
    return { content: Buffer.from(row.content), format, filename: `${row.workType.slug}-${row.id}.${format}` };
  }
}

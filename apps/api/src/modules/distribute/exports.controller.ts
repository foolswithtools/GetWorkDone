import { Body, Controller, Get, HttpCode, Param, Post, Res, StreamableFile } from '@nestjs/common';
import { CreateExportRequest, type ExportResponse } from '@getworkdone/contracts';
import type { Response } from 'express';
import { CurrentIdentity, type Identity } from '../../common/identity.js';
import { TakeQuota } from '../../common/quota.js';
import { parseBody } from '../../common/zod.js';
import { ExportsService, ExportTooSoon } from './exports.service.js';

const CONTENT_TYPES = { csv: 'text/csv; charset=utf-8', json: 'application/json; charset=utf-8' } as const;

// Members of the team only (team-member.guard.ts), for generating, listing and downloading alike.
@Controller('api/v1/teams/:teamId')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  /**
   * 429 with Retry-After within 30 seconds of the work type's last export, and past the team's exports an
   * hour (GWP#50, taken before the body is read); the final filter still writes and records it.
   */
  @Post('work-types/:workTypeId/exports')
  @HttpCode(201)
  @TakeQuota('exports')
  async create(
    @Param('teamId') teamId: string, @Param('workTypeId') workTypeId: string, @CurrentIdentity() identity: Identity, @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ExportResponse> {
    try {
      return await this.exports.create(teamId, workTypeId, parseBody(CreateExportRequest, body), identity.subject);
    } catch (error) {
      if (error instanceof ExportTooSoon) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      throw error;
    }
  }

  @Get('work-types/:workTypeId/exports')
  list(@Param('teamId') teamId: string, @Param('workTypeId') workTypeId: string): Promise<ExportResponse[]> {
    return this.exports.list(teamId, workTypeId);
  }

  /** The file, as an attachment; the slug and id in its name are safe in a header (Slug, uuid). */
  @Get('exports/:exportId/download')
  async download(@Param('teamId') teamId: string, @Param('exportId') exportId: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    const file = await this.exports.download(teamId, exportId);
    res.setHeader('content-type', CONTENT_TYPES[file.format]);
    res.setHeader('content-disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('x-content-type-options', 'nosniff');
    return new StreamableFile(file.content);
  }
}

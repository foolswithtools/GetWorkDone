import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { type CreateItemRequest, type CreateWorkTypeVersionRequest, type ItemDetailResponse, type ItemPage, type ItemStatus, type WorkTypeResponse } from '@getworkdone/contracts';
import { withSpan } from '@getworkdone/telemetry';
import { apiLogger } from '../../common/logger.js';
import { ItemsService } from '../items/items.service.js';
import { MatcherCache } from './matcher-cache.js';
import { ProcessService } from '../process/process.service.js';
import { ARCHIVED, WorkTypesService } from '../work-types/work-types.service.js';

/**
 * Capture (GWP#4, docs/capture.md): admins write a work type's next version from the builder, members
 * submit items validated against the latest version with the same validateCapture the browser runs.
 * A failed validation is 422 `{ errors }` and writes nothing.
 */
@Injectable()
export class CaptureService {
  constructor(
    private readonly workTypes: WorkTypesService,
    private readonly items: ItemsService,
    private readonly process: ProcessService,
    private readonly matchers: MatcherCache,
  ) {}

  /** The next version of a work type; definitions are immutable, so this never changes an earlier one. */
  addVersion(teamId: string, workTypeId: string, request: CreateWorkTypeVersionRequest): Promise<WorkTypeResponse> {
    return this.workTypes.reviseDefinition(teamId, workTypeId, request.definition);
  }

  /**
   * A new item on the work type's latest version, with its `captured` event, then processed (GWP#5):
   * its automated steps run until a human step or the end, so it answers `in_progress`, `failed` or,
   * for a type with no steps left to wait on, `completed`. If processing throws once the item exists
   * (GWP#22), the error is logged and the item is answered as it stands, so the submitter does not
   * capture it again; an admin resumes it with `POST .../items/:itemId/advance`, or the stuck-item sweeper
   * does (GWP#55). An archived work type (GWP#55) is 409 and writes nothing.
   */
  async submit(teamId: string, workTypeId: string, request: CreateItemRequest, actorSubject: string): Promise<ItemDetailResponse> {
    const outcome = await withSpan('capture.submit', async (span) => {
      const { version, archivedAt } = await this.workTypes.get(teamId, workTypeId);
      span.setAttributes({ 'work_type.id': workTypeId, 'work_type.version': version.version });
      // Like a rejected item, the submitter's error and not the span's: answered 409 outside the span.
      if (archivedAt !== null) return { archived: true as const };
      // validateCapture's checks, with the version's patterns compiled once (matcher-cache.ts).
      const result = this.matchers.validate(version, request.data);
      // A rejected item is the submitter's error, not the span's: it is answered 422 outside the span.
      if (!result.ok) return { errors: result.errors };
      const item = await this.items.create(teamId, { workTypeVersionId: version.id, data: result.data }, actorSubject, 'captured');
      try {
        return { item: await this.process.advance(teamId, item.id, item.rowVersion, actorSubject) };
      } catch (error) {
        // The answer is 201, so the span records what went wrong: a failure between transitions has no
        // process.step span of its own. A 409 is a lost race (an admin resumed the item meanwhile).
        span.recordException(error instanceof Error ? error : { message: String(error) });
        span.setAttribute('capture.processing_failed', true);
        const lost = error instanceof ConflictException;
        apiLogger[lost ? 'warn' : 'error']({ item_id: item.id, err: error }, 'processing a captured item stopped; it stays where it stopped');
        return { item: await this.items.get(teamId, item.id) };
      }
    });
    if ('archived' in outcome) throw new ConflictException(ARCHIVED);
    if ('errors' in outcome) throw new UnprocessableEntityException({ errors: outcome.errors });
    return outcome.item;
  }

  /**
   * A page of the work type's items, newest first, after `cursor`, only those in `status` when given
   * (GWP#54); another team's work type is not found.
   */
  async list(teamId: string, workTypeId: string, cursor?: string, status?: ItemStatus): Promise<ItemPage> {
    await this.workTypes.get(teamId, workTypeId);
    return this.items.listForWorkType(teamId, workTypeId, { cursor, status });
  }
}

import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { validateCapture, type ItemDetailResponse, type ItemStatus, type ProcessStep, type TeamRole, type WorkTypeDefinition } from '@getworkdone/contracts';
import { Prisma } from '@getworkdone/db';
import { withSpan } from '@getworkdone/telemetry';
import type { Span } from '@opentelemetry/api';
import { apiLogger } from '../../common/logger.js';
import { Database } from '../database/database.js';
import { completionPlan } from '../distribute/completion.js';
import { DeliveryWorker } from '../distribute/delivery.worker.js';
import { ItemsService } from '../items/items.service.js';
import { nextAction } from './engine.js';
import { runTransform } from './transforms.js';

/** An item as the engine reads it: its state, its version's definition and its last event's type. */
interface LoadedItem {
  id: string;
  teamId: string;
  status: ItemStatus;
  currentStepIndex: number;
  rowVersion: number;
  waitingRole: TeamRole | null;
  data: Record<string, unknown>;
  definition: WorkTypeDefinition;
  /** The type of its last transition event: a `data_edited` (GWP#23) moves no step, so it is passed over. */
  lastEventType: string | undefined;
}

type ProcessEventType = 'step_started' | 'step_completed' | 'step_failed' | 'completed' | 'data_edited' | 'cancelled';

/** An admin's edit of an item's data (GWP#23): an event the engine reads past, as it moves no step. */
const DATA_EDITED = 'data_edited';

/**
 * One transition: the item's change, the one ItemEvent written with it, and any other rows it writes.
 * `waitingRole` (GWP#55) is the role of the human step the transition starts; `transition` writes null
 * for every other transition but a `data_edited`, which moves no step and leaves it as it was.
 */
interface Transition {
  change: { status?: ItemStatus; currentStepIndex?: number; data?: Record<string, unknown>; waitingRole?: TeamRole };
  event: { type: ProcessEventType; actorSubject: string | null; payload: Record<string, unknown> };
  /** More writes in the same transaction, after the event (the `completed` transition's Delivery rows). */
  also?: (tx: Prisma.TransactionClient) => Promise<unknown>;
}

/**
 * An item the stuck-item sweeper may advance (GWP#55): where it is, the rowVersion it was read at, and how
 * many of the sweeper's advances in a row have failed since its last transition (GWP#102).
 */
export interface StuckItem { teamId: string; id: string; rowVersion: number; sweepFailures: number }

/** What the person completing a human step records on its event (GWP#54); never written to the data. */
export interface StepCompletion { decision?: string; comment?: string }

const STALE = 'The item changed since it was read; read it again';
/** GWP#54: once cancelled, nothing moves the item again. */
const CANCELLED = 'This item is already cancelled';
const NOT_WAITING = 'This step is not waiting for completion';
const NOT_FAILED = 'This step has not failed';
const article = (role: string) => (role === 'admin' ? 'an admin' : 'a member');
// Waiting for the item's row lock counts against the transaction; 20 racing completions of one step
// queue on it (and on the connection pool) before 19 of them find the rowVersion moved on. READ
// COMMITTED is Postgres's default, pinned here because the 409 rests on it: a blocked UPDATE re-checks
// its WHERE against the committed row and matches nothing, where REPEATABLE READ would raise instead.
const TRANSACTION = { maxWait: 10_000, timeout: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted };

function stepPayload(step: ProcessStep, index: number): Record<string, unknown> {
  return step.kind === 'automated'
    ? { stepId: step.id, stepIndex: index, kind: step.kind, transform: step.transform }
    : { stepId: step.id, stepIndex: index, kind: step.kind };
}

/**
 * The keys whose values differ between two versions of an item's data, sorted: added, removed or changed.
 * Captured values are JSON scalars (capture.ts), so `===` compares them. The `data_edited` payload lists
 * these and never the values (D-048).
 */
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key] || (key in before) !== (key in after)).sort();
}

function stepAttributes(transition: ProcessEventType, step: ProcessStep): Record<string, string> {
  return { 'process.transition': transition, 'step.kind': step.kind, 'step.id': step.id, ...(step.kind === 'automated' ? { 'transform.name': step.transform } : {}) };
}

/**
 * The process engine (GWP#5, docs/process.md). An item moves through its version's steps in order:
 * consecutive automated steps run until a human step, which waits for a completion from a member
 * holding its assigneeRole; after the last step the item is `completed` and onItemCompleted fires.
 * The `completed` transition also applies the item's outputs (GWP#6, docs/outputs.md): one Delivery row
 * per email or webhook output, and for output `none` the captured data cleared (D-048).
 *
 * Every transition is one transaction: an UPDATE of the item matching the rowVersion it was read at
 * (and incrementing it), then one ItemEvent with the next seq, inside one `process.step` span. A stale,
 * replayed or concurrent request matches no row, writes nothing and is 409.
 */
@Injectable()
export class ProcessService {
  constructor(private readonly db: Database, private readonly items: ItemsService, private readonly deliveries: DeliveryWorker) {}

  /**
   * Runs the item from where it stands, starting at `expectedRowVersion`: starts the current step, runs
   * automated steps, and stops at a human step, a failure or the end. `actor` is the person whose
   * request this is; automated steps' events have no actor.
   */
  async advance(teamId: string, itemId: string, expectedRowVersion: number, actor: string | null): Promise<ItemDetailResponse> {
    let rowVersion = expectedRowVersion;
    for (;;) {
      const item = await this.load(teamId, itemId);
      if (item.rowVersion !== rowVersion) throw new ConflictException(STALE);
      const action = nextAction(item.definition.steps, item, item.lastEventType);
      if (action.kind === 'wait') await this.repairWaitingRole(item, action.index);
      if (action.kind === 'stop' || action.kind === 'wait') return this.items.get(teamId, itemId);
      if (action.kind === 'complete') {
        const plan = completionPlan(item.definition.outputs, item);
        await this.transition(item, { 'process.transition': 'completed' }, () => ({
          change: { status: 'completed', ...(plan.clearData ? { data: {} } : {}) },
          event: { type: 'completed', actorSubject: actor, payload: plan.clearData ? { dataCleared: true } : {} },
          also: (tx) => tx.delivery.createMany({ data: plan.deliveries, skipDuplicates: true }),
        }));
        const completed = await this.items.get(teamId, itemId);
        await this.fireItemCompleted(completed);
        return completed;
      }
      const step = item.definition.steps[action.index] as ProcessStep;
      if (action.kind === 'start') {
        const payload = step.kind === 'human' ? { ...stepPayload(step, action.index), assigneeRole: step.assigneeRole } : stepPayload(step, action.index);
        await this.transition(item, stepAttributes('step_started', step), () => ({
          change: { status: 'in_progress', currentStepIndex: action.index, ...(step.kind === 'human' ? { waitingRole: step.assigneeRole } : {}) },
          event: { type: 'step_started', actorSubject: step.kind === 'human' ? actor : null, payload },
        }));
      } else {
        await this.transition(item, stepAttributes('step_completed', step), (span) => {
          const outcome = runTransform(step as Extract<ProcessStep, { kind: 'automated' }>, item.data, item.definition.fields);
          if (outcome.ok) return { change: { data: outcome.data, currentStepIndex: action.index + 1 }, event: { type: 'step_completed', actorSubject: null, payload: stepPayload(step, action.index) } };
          span.setAttribute('process.transition', 'step_failed');
          const payload = { ...stepPayload(step, action.index), reason: outcome.reason, ...(outcome.errors ? { errors: outcome.errors } : {}) };
          return { change: { status: 'failed' }, event: { type: 'step_failed', actorSubject: null, payload } };
        });
      }
      rowVersion += 1;
    }
  }

  /**
   * A person completes the human step the item is waiting at, then the item advances. The step must be
   * the current one and started, the caller must hold its assigneeRole (an admin holds `member` too),
   * and `expectedRowVersion` must be the item's: otherwise 409, or 403 for the role. A step that lists
   * `decisions` needs one of them as `completion.decision`, else 422 keyed `decision` (GWP#54); the
   * decision and comment go on the step_completed event only, never in the data.
   */
  async completeStep(teamId: string, itemId: string, stepId: string, expectedRowVersion: number, actor: string, completion: StepCompletion = {}): Promise<ItemDetailResponse> {
    const item = await this.load(teamId, itemId);
    const { step, index } = this.findStep(item, stepId);
    if (step.kind === 'human' && step.assigneeRole === 'admin' && (await this.roleOf(teamId, actor)) !== 'admin') throw new ForbiddenException('This step needs the team admin role');
    if (item.rowVersion !== expectedRowVersion) throw new ConflictException(STALE);
    if (item.status === 'cancelled') throw new ConflictException(CANCELLED);
    const waiting = step.kind === 'human' && nextAction(item.definition.steps, item, item.lastEventType).kind === 'wait' && item.currentStepIndex === index;
    if (!waiting) throw new ConflictException(NOT_WAITING);
    const { decision, comment } = completion;
    if (step.decisions && (decision === undefined || !step.decisions.includes(decision))) {
      throw new UnprocessableEntityException({ errors: { decision: [`Choose one of: ${step.decisions.join(', ')}`] } });
    }
    const payload = { ...stepPayload(step, index), ...(decision !== undefined ? { decision } : {}), ...(comment !== undefined ? { comment } : {}) };
    await this.transition(item, stepAttributes('step_completed', step), () => ({
      change: { currentStepIndex: index + 1 },
      event: { type: 'step_completed', actorSubject: actor, payload },
    }));
    return this.advance(teamId, itemId, expectedRowVersion + 1, actor);
  }

  /** An admin re-runs the failed step once (the route needs the admin role); on success the item advances. */
  async retry(teamId: string, itemId: string, stepId: string, expectedRowVersion: number, actor: string): Promise<ItemDetailResponse> {
    const item = await this.load(teamId, itemId);
    const { step, index } = this.findStep(item, stepId);
    if (item.rowVersion !== expectedRowVersion) throw new ConflictException(STALE);
    if (item.status === 'cancelled') throw new ConflictException(CANCELLED);
    if (item.status !== 'failed' || item.currentStepIndex !== index) throw new ConflictException(NOT_FAILED);
    await this.transition(item, stepAttributes('step_started', step), () => ({
      change: { status: 'in_progress' },
      event: { type: 'step_started', actorSubject: actor, payload: { ...stepPayload(step, index), retry: true } },
    }));
    return this.advance(teamId, itemId, expectedRowVersion + 1, actor);
  }

  /**
   * An admin resumes an item whose processing stopped between two transitions (GWP#22, the route needs
   * the admin role): it is `open`, or `in_progress` and not waiting at a started human step. It then
   * advances as the request that stopped would have. Every refusal is 409 and comes before any write.
   */
  async resume(teamId: string, itemId: string, expectedRowVersion: number, actor: string): Promise<ItemDetailResponse> {
    const item = await this.load(teamId, itemId);
    if (item.rowVersion !== expectedRowVersion) throw new ConflictException(STALE);
    const name = (index: number) => {
      const step = item.definition.steps[index];
      return step?.name || step?.id || String(index);
    };
    if (item.status === 'failed') throw new ConflictException(`This item failed at step "${name(item.currentStepIndex)}"; retry that step instead`);
    if (item.status !== 'open' && item.status !== 'in_progress') throw new ConflictException(`This item is already ${item.status}`);
    const action = nextAction(item.definition.steps, item, item.lastEventType);
    if (action.kind === 'wait') {
      const step = item.definition.steps[action.index] as Extract<ProcessStep, { kind: 'human' }>;
      throw new ConflictException(`This item is waiting at step "${name(action.index)}" for ${article(step.assigneeRole)} to complete it`);
    }
    if (action.kind === 'stop') throw new ConflictException('This item has no step to resume at');
    return this.advance(teamId, itemId, expectedRowVersion, actor);
  }

  /**
   * An admin replaces the item's data (GWP#23, the route needs the admin role) while it is `failed`, or
   * `in_progress` waiting at a started human step, so a retry or the step's completion sees the corrected
   * data. A stale `expectedRowVersion` or any other state is 409, then data that fails validateCapture
   * against the item's own version is 422 `{ errors }`; each refusal comes before any write. Data that
   * changes nothing writes nothing. Otherwise one transition writes the data and a `data_edited` event
   * naming the changed keys, never their values (D-048); the item's status and step stay as they were.
   */
  async editData(teamId: string, itemId: string, expectedRowVersion: number, data: Record<string, unknown>, actor: string): Promise<ItemDetailResponse> {
    const item = await this.load(teamId, itemId);
    if (item.rowVersion !== expectedRowVersion) throw new ConflictException(STALE);
    const action = nextAction(item.definition.steps, item, item.lastEventType);
    if (item.status !== 'failed' && action.kind !== 'wait') {
      throw new ConflictException(item.status === 'completed' || item.status === 'cancelled'
        ? `This item is already ${item.status}`
        : 'Only a failed item, or one waiting at a human step, can have its data edited');
    }
    const checked = validateCapture([...item.definition.fields], data);
    if (!checked.ok) throw new UnprocessableEntityException({ errors: checked.errors });
    const fields = changedFields(item.data, checked.data);
    if (fields.length === 0) return this.items.get(teamId, itemId);
    const step = item.definition.steps[item.currentStepIndex];
    const attributes = step ? stepAttributes(DATA_EDITED, step) : { 'process.transition': DATA_EDITED };
    await this.transition(item, attributes, () => ({
      change: { data: checked.data },
      event: { type: DATA_EDITED, actorSubject: actor, payload: { fields } },
    }));
    return this.items.get(teamId, itemId);
  }

  /**
   * An admin cancels the item (GWP#54, the route needs the admin role) while it is `open`, `in_progress`
   * (waiting at a human step or not) or `failed`. A stale `expectedRowVersion` is 409, then a `completed`
   * or `cancelled` item is 409 naming its status; each refusal comes before any write. One transition sets
   * `cancelled` and writes a `cancelled` event with the reason when given. No output fires and the data
   * is kept: output `none` clears data at completion only (D-048), and a cancelled item never completes.
   */
  async cancel(teamId: string, itemId: string, expectedRowVersion: number, reason: string | undefined, actor: string): Promise<ItemDetailResponse> {
    const item = await this.load(teamId, itemId);
    if (item.rowVersion !== expectedRowVersion) throw new ConflictException(STALE);
    if (item.status === 'completed' || item.status === 'cancelled') throw new ConflictException(`This item is already ${item.status}`);
    const step = item.definition.steps[item.currentStepIndex];
    const attributes = step ? stepAttributes('cancelled', step) : { 'process.transition': 'cancelled' };
    await this.transition(item, attributes, () => ({
      change: { status: 'cancelled' },
      event: { type: 'cancelled', actorSubject: actor, payload: reason !== undefined ? { reason } : {} },
    }));
    return this.items.get(teamId, itemId);
  }

  /**
   * Items whose processing may have stopped between transitions, for the stuck-item sweeper (GWP#55): `open`
   * or `in_progress`, not waiting at a human step (waitingRole null), last updated before `before`; the
   * oldest update first, at most `limit`, across every team (the partial index
   * Item_status_updatedAt_waiting_null_idx, GWP#157). An item the sweeper has backed off (GWP#102) is listed
   * only once its sweepRetryAt is at or before `now`, and after every item it has not tried (fewest failures
   * first), so items that keep failing never take the batch from one behind them that has not had its turn.
   * A failed item waits for an admin's retry and is never listed.
   */
  async stuckItems(before: Date, limit: number, now: Date): Promise<StuckItem[]> {
    return this.db.client.item.findMany({
      where: { status: { in: ['open', 'in_progress'] }, waitingRole: null, updatedAt: { lt: before }, OR: [{ sweepRetryAt: null }, { sweepRetryAt: { lte: now } }] },
      orderBy: [{ sweepFailures: 'asc' }, { updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { teamId: true, id: true, rowVersion: true, sweepFailures: true },
    });
  }

  /**
   * GWP#102: the sweeper could not advance `item`, so it is not listed again before `retryAt`, and its
   * sweepFailures goes up by one. No event, and no rowVersion or updatedAt change: the item has not moved,
   * and its place in the sweep's order stays its last real update. Matched on the rowVersion and
   * sweepFailures the sweeper listed, so a transition since, or another sweep's backoff, wins and this
   * writes nothing.
   */
  async backOffStuckItem(item: StuckItem, retryAt: Date): Promise<void> {
    await this.db.client.$executeRaw`
      UPDATE "Item" SET "sweepRetryAt" = ${retryAt}, "sweepFailures" = "sweepFailures" + 1
      WHERE id = ${item.id} AND "teamId" = ${item.teamId} AND "rowVersion" = ${item.rowVersion} AND "sweepFailures" = ${item.sweepFailures}`;
  }

  /**
   * Fires once per item, after the `completed` transition commits: wakes the delivery worker (GWP#6). The
   * Delivery rows were written by the transition itself, so if this never runs the worker's poll still
   * finds them.
   */
  onItemCompleted(_item: ItemDetailResponse): Promise<void> | void {
    this.deliveries.kick();
  }

  private async fireItemCompleted(item: ItemDetailResponse): Promise<void> {
    try {
      await this.onItemCompleted(item);
    } catch (error) {
      // The item is completed either way, and its Delivery rows are already written.
      apiLogger.error({ item_id: item.id, err: error }, 'onItemCompleted failed');
    }
  }

  private async load(teamId: string, itemId: string): Promise<LoadedItem> {
    const row = await this.db.client.item.findFirst({
      where: { id: itemId, teamId },
      include: { workTypeVersion: { select: { definition: true } }, events: { where: { type: { not: DATA_EDITED } }, orderBy: { seq: 'desc' }, take: 1, select: { type: true } } },
    });
    if (!row) throw new NotFoundException('Item not found');
    return {
      id: row.id, teamId: row.teamId, status: row.status, currentStepIndex: row.currentStepIndex, rowVersion: row.rowVersion, waitingRole: row.waitingRole,
      data: row.data as Record<string, unknown>,
      // Validated when the version was written and never changed since (work-types.service.ts).
      definition: row.workTypeVersion.definition as WorkTypeDefinition,
      lastEventType: row.events[0]?.type,
    };
  }

  /**
   * GWP#55: an item found waiting at a started human step whose waitingRole is not that step's role, as
   * one a task running code from before the column left mid-deploy, gets the role in place: it joins the
   * queue and leaves the stuck-item sweeper's list (its updatedAt moves on). No event and no rowVersion
   * change, as the column only mirrors the events; matched on rowVersion, so a lost race changes nothing.
   */
  private async repairWaitingRole(item: LoadedItem, index: number): Promise<void> {
    const step = item.definition.steps[index] as Extract<ProcessStep, { kind: 'human' }>;
    if (item.waitingRole === step.assigneeRole) return;
    await this.db.client.item.updateMany({ where: { id: item.id, teamId: item.teamId, rowVersion: item.rowVersion }, data: { waitingRole: step.assigneeRole } });
    apiLogger.warn({ item_id: item.id, waiting_role: step.assigneeRole }, 'set the waiting role of an item found waiting without it');
  }

  private findStep(item: LoadedItem, stepId: string): { step: ProcessStep; index: number } {
    const index = item.definition.steps.findIndex((s) => s.id === stepId);
    const step = item.definition.steps[index];
    if (!step) throw new NotFoundException('Step not found');
    return { step, index };
  }

  private async roleOf(teamId: string, subject: string): Promise<string | undefined> {
    return (await this.db.client.teamMember.findUnique({ where: { teamId_subject: { teamId, subject } }, select: { role: true } }))?.role;
  }

  /**
   * One transition in one transaction, inside a `process.step` span. The guarded UPDATE comes first: it
   * takes the item's row lock, so the seq read after it cannot race another transition's.
   */
  private async transition(item: LoadedItem, attributes: Record<string, string>, build: (span: Span) => Transition): Promise<void> {
    const applied = await withSpan('process.step', async (span) => {
      span.setAttributes(attributes);
      const { change, event, also } = build(span);
      return this.db.client.$transaction(async (tx) => {
        const { data, waitingRole, ...rest } = change;
        // The queue's column (GWP#55): set as a human step starts, kept by a data edit, else cleared.
        const waiting = event.type === DATA_EDITED ? {} : { waitingRole: waitingRole ?? null };
        // Every transition ends the sweeper's backoff (GWP#102): the item it could not advance has moved.
        const unblocked = { sweepRetryAt: null, sweepFailures: 0 };
        const updated = await tx.item.updateMany({
          where: { id: item.id, teamId: item.teamId, rowVersion: item.rowVersion },
          data: { ...rest, ...waiting, ...unblocked, ...(data ? { data: data as Prisma.InputJsonObject } : {}), rowVersion: { increment: 1 } },
        });
        if (updated.count !== 1) return false;
        const last = await tx.itemEvent.aggregate({ where: { itemId: item.id }, _max: { seq: true } });
        await tx.itemEvent.create({ data: { itemId: item.id, seq: (last._max.seq ?? 0) + 1, type: event.type, actorSubject: event.actorSubject, payload: event.payload as Prisma.InputJsonObject } });
        await also?.(tx);
        return true;
      }, TRANSACTION);
    });
    // A lost race is the caller's stale read, not the span's error: it is answered 409 outside the span.
    if (!applied) throw new ConflictException(STALE);
  }
}

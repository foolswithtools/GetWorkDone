// The delivery worker (GWP#6, docs/outputs.md). It claims one due pending Delivery row at a time with
// SELECT ... FOR UPDATE SKIP LOCKED, in a short transaction that counts the attempt and leases the row
// (nextAttemptAt moves past the longest deadline), then sends outside any transaction and writes the
// outcome only if the row is still the one it claimed. So two workers never send one row at once, a
// delivered row is never sent again, and a worker that dies between a send and its commit leaves the row
// to be sent again, with the same Idempotency-Key, when the lease lapses.
//
// Retries: at most MAX_ATTEMPTS attempts, the next one BACKOFF_MS[n - 1] after the n-th retryable
// failure; the last failure, or any `failed` result, ends the row `failed` with a `delivery_failed`
// ItemEvent. A row whose last attempt's claim lapsed (the worker died) is ended `failed` with reason
// `interrupted` when next claimed, never sent a fourth time.
//
// Quota (GWP#50): before each attempt the worker takes the team's deliveries an hour. A refused take
// reverts the claim in the same guarded write as an outcome (attempts back, due at the window's end,
// lastError `quota_deferred`): a deferral is not an attempt, so it never counts toward MAX_ATTEMPTS.
// A take that throws (the store unreachable) reverts the attempt the same way but keeps the lease (GWP#74),
// so a row is never ended `interrupted` for attempts it never made.
//
// Schema (GWP#101): on a fresh instance the API starts before the migration, so the worker claims nothing
// until the Delivery table exists (waitForSchema, ../database/schema-ready.ts): one `warn` while it waits,
// one `info` (`delivery worker started`) when it starts polling. After that a failed run logs at error.
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DEFAULT_DEADLINE_MS, MAX_DEADLINE_MS, type CaptureField, type WorkTypeDefinition } from '@getworkdone/contracts';
import { Prisma, type Delivery } from '@getworkdone/db';
import { recordDistributionDelivery, withSpan } from '@getworkdone/telemetry';
import { SpanStatusCode } from '@opentelemetry/api';
import { apiLogger } from '../../common/logger.js';
import { deferral, QuotaLimiter, type QuotaVerdict } from '../../common/quota.js';
import { Database } from '../database/database.js';
import { schemaReady, waitForSchema, type SchemaWait } from '../database/schema-ready.js';
import { DISTRIBUTE_RUNTIME, type DistributeRuntime } from './distribute.options.js';
import { deadline } from './deadline.js';
import type { CompletedItem, DeliveryResult } from './output-adapter.js';

export const MAX_ATTEMPTS = 3;
/**
 * The wait after the 1st, 2nd and 3rd retryable failure. With three attempts the third failure is
 * final, so the 10-minute step is reached only if MAX_ATTEMPTS grows.
 */
export const BACKOFF_MS = [30_000, 120_000, 600_000] as const;
/** A claim's lease: past the longest deadline, so a live attempt is never claimed twice. */
export const LEASE_MS = MAX_DEADLINE_MS + 30_000;
/** Rows one worker sends at once. */
const CONCURRENCY = 4;

interface Loaded {
  item: CompletedItem;
  config: unknown;
  deadlineMs: number;
}

/** A deadline the output set, if it is a whole number in range; the default otherwise. */
function deadlineOf(config: unknown): number {
  const value = (config as { deadlineMs?: unknown } | null)?.deadlineMs;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_DEADLINE_MS ? value : DEFAULT_DEADLINE_MS;
}

@Injectable()
export class DeliveryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private stopping = false;
  private schema: SchemaWait | undefined;

  constructor(private readonly db: Database, @Inject(DISTRIBUTE_RUNTIME) private readonly runtime: DistributeRuntime, private readonly quotas: QuotaLimiter) {}

  onApplicationBootstrap(): void {
    if (!this.runtime.autoRun) return;
    this.schema = waitForSchema({
      job: 'delivery worker',
      table: 'Delivery',
      check: () => schemaReady(this.db, 'Delivery'),
      firstDelayMs: this.runtime.pollMs,
      onReady: () => {
        this.timer = setInterval(() => this.kick(), this.runtime.pollMs);
        this.timer.unref();
        this.kick();
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    // Lanes finish the attempt in hand and claim nothing more, before the database client disconnects.
    this.stopping = true;
    await this.schema?.stop();
    clearInterval(this.timer);
    this.timer = undefined;
    this.again = false;
    await this.running;
  }

  /**
   * Send what is due now, in the background; a no-op unless autoRun and the Delivery table exists. Called
   * when an item completes.
   */
  kick(): void {
    if (!this.runtime.autoRun || !this.schema?.ready || this.stopping) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.runOnce()
      .then(() => undefined, (error: unknown) => apiLogger.error({ err: error }, 'delivery run failed'))
      .finally(() => {
        this.running = undefined;
        if (this.again && this.timer) {
          this.again = false;
          this.kick();
        }
      });
  }

  /**
   * Claims and sends due rows until none is left; resolves with how many attempts it made. `itemIds` limits it to
   * those items' rows (tests share one database).
   */
  async runOnce(scope: { itemIds?: string[] } = {}): Promise<number> {
    let attempts = 0;
    const lane = async () => {
      while (!this.stopping) {
        const claimed = await this.claim(scope.itemIds);
        if (!claimed) return;
        if (claimed === 'ended') continue;
        try {
          if (await this.deferred(claimed)) continue;
          attempts += 1;
          await this.attempt(claimed);
        } catch (error) {
          // The row stays leased and is tried again when the lease lapses.
          apiLogger.error({ delivery_id: claimed.id, err: error }, 'delivery attempt not recorded');
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, lane));
    return attempts;
  }

  /**
   * The next due pending row, its attempt counted and its lease taken; undefined when none is due, and
   * `ended` when the due row had used its last attempt (a lapsed claim) and was ended `failed` instead.
   */
  private async claim(itemIds: string[] | undefined): Promise<Delivery | 'ended' | undefined> {
    if (itemIds && itemIds.length === 0) return undefined;
    const now = this.runtime.now();
    return this.db.client.$transaction(async (tx) => {
      const due = Prisma.sql`status = 'pending' AND "nextAttemptAt" <= ${now.toISOString()}::timestamp`;
      const scope = itemIds ? Prisma.sql`AND "itemId" IN (${Prisma.join(itemIds)})` : Prisma.empty;
      const [row] = await tx.$queryRaw<{ id: string; attempts: number }[]>`SELECT id, attempts FROM "Delivery" WHERE ${due} ${scope} ORDER BY "nextAttemptAt", id LIMIT 1 FOR UPDATE SKIP LOCKED`;
      if (!row) return undefined;
      if (row.attempts >= MAX_ATTEMPTS) {
        await this.fail(tx, await tx.delivery.findUniqueOrThrow({ where: { id: row.id } }), 'interrupted');
        return 'ended';
      }
      return tx.delivery.update({ where: { id: row.id }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + LEASE_MS) } });
    });
  }

  /**
   * Takes the team's delivery quota; past it, reverts the claim (attempts back, due when the window ends,
   * `quota_deferred`) if the row is still as claimed, and resolves true. Status stays pending, no event.
   * If the take throws, reverts only the attempt (the row waits out its lease) and resolves true; if that
   * write throws too, the lane logs it and the claim counts, as for any unrecorded attempt.
   */
  private async deferred(delivery: Delivery): Promise<boolean> {
    const claimed = { id: delivery.id, status: 'pending' as const, attempts: delivery.attempts };
    let verdict: QuotaVerdict;
    try {
      verdict = await this.quotas.take('deliveries', delivery.teamId);
    } catch (error) {
      await this.db.client.delivery.updateMany({ where: claimed, data: { attempts: { decrement: 1 } } });
      apiLogger.error({ delivery_id: delivery.id, err: error }, 'delivery quota take failed; attempt reverted');
      return true;
    }
    if (verdict.allowed) return false;
    await this.db.client.delivery.updateMany({ where: claimed, data: { attempts: { decrement: 1 }, ...deferral(verdict) } });
    return true;
  }

  /** One attempt: load, send inside `distribute.deliver`, count it, write the outcome. */
  private async attempt(delivery: Delivery): Promise<void> {
    const loaded = await this.load(delivery);
    const adapter = delivery.kind === 'email' ? this.runtime.adapters.email : this.runtime.adapters.webhook;
    const result = await withSpan('distribute.deliver', async (span): Promise<DeliveryResult> => {
      span.setAttributes({ 'output.kind': delivery.kind, 'output.id': delivery.outputId, 'delivery.attempt': delivery.attempts, 'item.id': delivery.itemId });
      let outcome: DeliveryResult;
      if (!loaded) {
        outcome = { status: 'failed', reason: 'output_not_found' };
      } else {
        try {
          const { signal, clear } = deadline(loaded.deadlineMs);
          try {
            outcome = await adapter.deliver(loaded.item, loaded.config, { idempotencyKey: delivery.idempotencyKey, deadlineMs: loaded.deadlineMs, signal });
          } finally {
            clear();
          }
        } catch (error) {
          apiLogger.error({ delivery_id: delivery.id, err: error }, 'output adapter threw');
          outcome = { status: 'retryable', reason: 'adapter_error' };
        }
      }
      span.setAttribute('delivery.status', outcome.status);
      if (outcome.status !== 'delivered') {
        span.setAttribute('delivery.reason', outcome.reason);
        span.setStatus({ code: SpanStatusCode.ERROR, message: outcome.reason });
      }
      return outcome;
    });
    recordDistributionDelivery({ kind: delivery.kind, status: result.status });
    await this.runtime.afterSend?.(delivery);
    await this.finish(delivery, result);
  }

  /** The completed item, the output's config (with its secret for a webhook) and its deadline. */
  private async load(delivery: Delivery): Promise<Loaded | undefined> {
    // Only the columns it sends: the worker waits for Delivery alone, so a column a later migration adds
    // to Item must not be read before that migration lands (GWP#127, sweep_backoff's).
    const row = await this.db.client.item.findFirst({
      where: { id: delivery.itemId, teamId: delivery.teamId },
      select: {
        id: true, teamId: true, workTypeVersionId: true, data: true, createdAt: true, updatedAt: true,
        workTypeVersion: { select: { version: true, definition: true, workType: { select: { id: true, slug: true } } } },
        events: { where: { type: 'completed' }, orderBy: { seq: 'desc' }, take: 1, select: { at: true } },
      },
    });
    // Validated when the version was written and never changed since (work-types.service.ts).
    const definition = row?.workTypeVersion.definition as WorkTypeDefinition | undefined;
    const output = definition?.outputs.find((o) => o.id === delivery.outputId);
    if (!row || !definition || !output) return undefined;
    const { workType } = row.workTypeVersion;
    let config: unknown = output.config;
    if (output.kind === 'webhook') {
      const secret = await this.db.client.outputSecret.findUnique({ where: { workTypeId_outputId: { workTypeId: workType.id, outputId: output.id } }, select: { secret: true } });
      config = { ...output.config, ...(secret ? { secret: secret.secret } : {}) };
    }
    return {
      item: {
        id: row.id, teamId: row.teamId, workTypeVersionId: row.workTypeVersionId, data: row.data as Record<string, unknown>,
        createdAt: row.createdAt.toISOString(), completedAt: (row.events[0]?.at ?? row.updatedAt).toISOString(),
        workType: { id: workType.id, slug: workType.slug, version: row.workTypeVersion.version, fields: definition.fields as CaptureField[] },
      },
      config,
      deadlineMs: deadlineOf(output.config),
    };
  }

  /**
   * Writes the outcome, only if the row is still pending at the attempt this worker claimed: a worker
   * whose lease lapsed and whose row was claimed again writes nothing.
   */
  private async finish(delivery: Delivery, result: DeliveryResult): Promise<void> {
    const now = this.runtime.now();
    const claimed = { id: delivery.id, status: 'pending' as const, attempts: delivery.attempts };
    if (result.status === 'delivered') {
      await this.db.client.delivery.updateMany({ where: claimed, data: { status: 'delivered', deliveredAt: now, lastError: null, nextAttemptAt: now } });
      return;
    }
    if (result.status === 'retryable' && delivery.attempts < MAX_ATTEMPTS) {
      const wait: number = BACKOFF_MS[delivery.attempts - 1] ?? BACKOFF_MS[2];
      await this.db.client.delivery.updateMany({ where: claimed, data: { lastError: result.reason, nextAttemptAt: new Date(now.getTime() + wait) } });
      return;
    }
    await this.db.client.$transaction((tx) => this.fail(tx, delivery, result.reason));
  }

  /** Ends the row `failed` with `reason` and writes its `delivery_failed` event, if the row is still as claimed. */
  private async fail(tx: Prisma.TransactionClient, delivery: Delivery, reason: string): Promise<void> {
    const updated = await tx.delivery.updateMany({ where: { id: delivery.id, status: 'pending', attempts: delivery.attempts }, data: { status: 'failed', lastError: reason } });
    if (updated.count !== 1) return;
    // The item's row lock orders this event's seq after any other writer's, as a transition's UPDATE does.
    await tx.$queryRaw`SELECT id FROM "Item" WHERE id = ${delivery.itemId} FOR UPDATE`;
    const last = await tx.itemEvent.aggregate({ where: { itemId: delivery.itemId }, _max: { seq: true } });
    await tx.itemEvent.create({
      data: {
        itemId: delivery.itemId, seq: (last._max.seq ?? 0) + 1, type: 'delivery_failed', actorSubject: null,
        payload: { outputId: delivery.outputId, kind: delivery.kind, attempts: delivery.attempts, reason },
      },
    });
  }
}

// The delivery backlog gauge (GWP#53, docs/outputs.md "Deliveries"): distribution_deliveries_pending is
// the number of Delivery rows still pending, counted through the [status, nextAttemptAt] index each time
// the metrics are exported (every 15 s), with a 5 s timeout. Every task counts the same table, so the
// panel and the `<env> delivery backlog` rule take the max across tasks. At bootstrap it also starts each
// delivered kind's failed-delivery series at 0, so the `<env> delivery failed` rule sees a task's first
// failure as an increase. While a count is still outstanding (a blackholed database), the next export
// waits on it again rather than queue another connection attempt in the pg pool, as Readiness does
// for its SELECT 1 (GWP#86). On a fresh instance it counts nothing until the Delivery table exists
// (GWP#101, ../database/schema-ready.ts): checked at bootstrap, then from DELIVERY_POLL_MS doubling up to
// 60 s, with one `warn` while absent and one `info` when it starts; until then each export is skipped.
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DELIVERED_KINDS } from '@getworkdone/contracts';
import { primeFailedDeliveries, registerDeliveryBacklog } from '@getworkdone/telemetry';
import { Database } from '../database/database.js';
import { schemaReady, waitForSchema, type SchemaWait } from '../database/schema-ready.js';
import { DISTRIBUTE_RUNTIME, type DistributeRuntime } from './distribute.options.js';

@Injectable()
export class DeliveryBacklog implements OnApplicationBootstrap, OnModuleDestroy {
  private unregister: (() => void) | undefined;
  private count: Promise<number> | undefined;
  private schema: SchemaWait | undefined;

  constructor(private readonly db: Database, @Inject(DISTRIBUTE_RUNTIME) private readonly runtime: Pick<DistributeRuntime, 'pollMs'>) {}

  onApplicationBootstrap(): void {
    // At bootstrap, after main.ts has registered the OTLP meter provider.
    primeFailedDeliveries(DELIVERED_KINDS);
    this.schema = waitForSchema({ job: 'delivery backlog gauge', table: 'Delivery', check: () => schemaReady(this.db, 'Delivery'), firstDelayMs: this.runtime.pollMs, onReady: () => undefined });
    this.unregister = registerDeliveryBacklog(() => this.pending());
  }

  async onModuleDestroy(): Promise<void> {
    // Before the database client disconnects, so no export counts on a closed pool.
    this.unregister?.();
    this.unregister = undefined;
    await this.schema?.stop();
  }

  /**
   * The Delivery rows with status pending, or the count still in flight. Rejects, so the export skips,
   * while the table does not exist yet; an export during a schema check waits for its answer.
   */
  async pending(): Promise<number> {
    if (this.schema && !this.schema.ready) {
      await this.schema.settled();
      if (!this.schema.ready) throw new Error('delivery backlog gauge waiting for the database schema');
    }
    this.count ??= this.db.client.delivery.count({ where: { status: 'pending' } }).finally(() => {
      this.count = undefined;
    });
    return this.count;
  }
}

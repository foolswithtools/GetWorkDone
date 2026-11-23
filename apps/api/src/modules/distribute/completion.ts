// What an item's `completed` transition writes for its outputs (GWP#6, D-048; docs/outputs.md). The
// process engine runs this inside that transition's transaction, so a completed item always has its
// Delivery rows (an outbox): nothing is lost if the process stops right after the commit.
import { isDeliveredKind, type DistributionOutput } from '@getworkdone/contracts';

export interface CompletionPlan {
  /** Output `none`: Item.data is cleared at completion; the audit trail is kept (D-048). */
  clearData: boolean;
  /** One pending Delivery row per email or webhook output. */
  deliveries: { teamId: string; itemId: string; outputId: string; kind: string; idempotencyKey: string }[];
}

export function completionPlan(outputs: readonly DistributionOutput[], item: { id: string; teamId: string }): CompletionPlan {
  return {
    clearData: outputs.some((o) => o.kind === 'none'),
    deliveries: outputs.filter((o) => isDeliveredKind(o.kind)).map((o) => ({
      teamId: item.teamId, itemId: item.id, outputId: o.id, kind: o.kind, idempotencyKey: `${item.id}:${o.id}`,
    })),
  };
}

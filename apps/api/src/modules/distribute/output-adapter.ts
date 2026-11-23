// The output adapter contract (GWP#6, docs/outputs.md), verbatim from the issue. An adapter delivers one
// completed item to one output: the delivery worker (delivery.worker.ts) claims the Delivery row, builds
// the context and turns the result into the row's next state. An adapter never throws for an outcome it
// can name; it answers `retryable` for what may pass (a timeout, a 5xx, throttling) and `failed` for
// what will not (a blocked address, a 4xx, an unverified recipient).
import type { CaptureField } from '@getworkdone/contracts';

/** A completed item as an adapter sees it: its data and the work type version it was captured under. */
export interface CompletedItem {
  id: string;
  teamId: string;
  workTypeVersionId: string;
  data: Record<string, unknown>;
  createdAt: string;
  /** When the item's `completed` event was written. */
  completedAt: string;
  workType: { id: string; slug: string; version: number; fields: CaptureField[] };
}

export interface DeliveryContext { idempotencyKey: string; deadlineMs: number; signal: AbortSignal }
export type DeliveryResult = { status: 'delivered' } | { status: 'retryable'; reason: string } | { status: 'failed'; reason: string };
export interface OutputAdapter {
  readonly kind: 'email' | 'webhook' | 'export';
  deliver(item: CompletedItem, config: unknown, ctx: DeliveryContext): Promise<DeliveryResult>;
}

// How distribution is configured (GWP#6, docs/outputs.md). Production reads the environment
// (EMAIL_TRANSPORT, EMAIL_FROM, DELIVERY_POLL_MS); tests pass their own receiver, mail transport and
// clock through createApp's `distribute` option.
import type { Delivery } from '@getworkdone/db';
import { EmailAdapter, emailTransportFromEnv, type EmailTransport } from './email.adapter.js';
import type { OutputAdapter } from './output-adapter.js';
import { WebhookAdapter, type WebhookAdapterOptions } from './webhook.adapter.js';

export const DISTRIBUTE_RUNTIME = Symbol('DISTRIBUTE_RUNTIME');

export interface DistributeOptions {
  webhook?: WebhookAdapterOptions;
  /** The mail transport and sender; from EMAIL_TRANSPORT and EMAIL_FROM when absent. */
  email?: { transport?: EmailTransport; from?: string };
  now?: () => Date;
  /** Poll for due deliveries and send on completion; on by default except under NODE_ENV=test. */
  autoRun?: boolean;
  pollMs?: number;
}

export interface DistributeRuntime {
  adapters: { webhook: OutputAdapter; email: OutputAdapter };
  now: () => Date;
  autoRun: boolean;
  pollMs: number;
  /**
   * Runs after an adapter answers and before its result is written. A test seam: throwing here stands
   * for the process dying between a send and its commit.
   */
  afterSend?: (delivery: Delivery) => void | Promise<void>;
}

const DEFAULT_POLL_MS = 5_000;

/** The runtime for `options`, filling the rest from `env`. Throws on an email setting that cannot work. */
export function distributeRuntime(options: DistributeOptions = {}, env: NodeJS.ProcessEnv = process.env): DistributeRuntime {
  const transport = options.email?.transport ?? emailTransportFromEnv(env);
  const pollMs = options.pollMs ?? (Number(env.DELIVERY_POLL_MS) || DEFAULT_POLL_MS);
  return {
    adapters: { webhook: new WebhookAdapter(options.webhook), email: new EmailAdapter(transport, options.email?.from ?? (env.EMAIL_FROM || undefined)) },
    now: options.now ?? (() => new Date()),
    autoRun: options.autoRun ?? env.NODE_ENV !== 'test',
    pollMs,
  };
}

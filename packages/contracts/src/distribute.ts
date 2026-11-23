// Distribution outputs (GWP#6, D-028, D-041, D-048; docs/outputs.md). Each output kind's `config` is a
// Zod object defined here, so the API's adapters (apps/api/src/modules/distribute) and the builder's
// output editor share one schema, and both run outputProblems, the save-time checks, over a
// definition's outputs. Save-time checks look at shape only: a webhook's address is checked when it is
// sent to, never when it is saved.
import { z } from 'zod';
import type { CaptureErrors } from './capture.js';
import type { OutputKind, WorkTypeDefinition } from './domain.js';

/** An output id is half of a delivery's idempotency key (`<itemId>:<outputId>`): no colon, no space. */
const OUTPUT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Each delivery attempt's deadline: 10 s unless the output sets one, at most 30 s. */
export const DEFAULT_DEADLINE_MS = 10_000;
export const MAX_DEADLINE_MS = 30_000;
export const MIN_DEADLINE_MS = 1_000;
/** An email output sends to at most this many recipients, all of them configured on the output. */
export const MAX_RECIPIENTS = 20;
/** One item is emailed to at most this many recipients, summed over every email output of its definition (GWP#50). */
export const MAX_RECIPIENTS_PER_ITEM = 20;
/** An export larger than this is refused rather than stored. */
export const MAX_EXPORT_BYTES = 10 * 1024 * 1024;

const Deadline = z.number().int().min(MIN_DEADLINE_MS).max(MAX_DEADLINE_MS).optional().meta({ title: 'Deadline per attempt (ms)' });

/** An https URL with a host and no user name or password in it. */
const WebhookUrl = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}, 'Use an https:// URL without a user name or password');

export const WebhookConfig = z.object({ url: WebhookUrl, deadlineMs: Deadline }).strict();
export const EmailConfig = z.object({
  recipients: z.array(z.email('Use an email address')).min(1, 'Add at least one recipient').max(MAX_RECIPIENTS, `At most ${MAX_RECIPIENTS} recipients`),
  subject: z.string().max(200).optional(),
  deadlineMs: Deadline,
}).strict();
export const ExportFormat = z.enum(['csv', 'json']);
export const ExportConfig = z.object({ format: ExportFormat.default('csv') }).strict();
const NoConfig = z.object({}).strict();

/** Each output kind's config schema. */
export const OUTPUT_CONFIGS = {
  none: NoConfig,
  persist: NoConfig,
  email: EmailConfig,
  webhook: WebhookConfig,
  export: ExportConfig,
} as const satisfies Record<OutputKind, z.ZodType>;

/** The kinds that send something per completed item (a Delivery row each); export is on request. */
export const DELIVERED_KINDS = ['email', 'webhook'] as const;
export type DeliveredKind = (typeof DELIVERED_KINDS)[number];
export function isDeliveredKind(kind: OutputKind): kind is DeliveredKind {
  return (DELIVERED_KINDS as readonly string[]).includes(kind);
}

export type WebhookConfig = z.infer<typeof WebhookConfig>;
export type EmailConfig = z.infer<typeof EmailConfig>;
export type ExportConfig = z.infer<typeof ExportConfig>;
export type ExportFormat = z.infer<typeof ExportFormat>;

/**
 * The save-time checks on a definition's outputs, keyed by dotted path (`outputs.0.config.url`); empty
 * when every output is valid. Ids must be unique and usable in an idempotency key; each config must
 * parse with its kind's schema; the email outputs together name at most MAX_RECIPIENTS_PER_ITEM
 * recipients, keyed `outputs` (GWP#50).
 */
export function outputProblems(definition: WorkTypeDefinition): CaptureErrors {
  const errors: CaptureErrors = {};
  const add = (path: string, message: string) => (errors[path] ??= []).push(message);
  const seen = new Set<string>();
  definition.outputs.forEach((output, index) => {
    const at = `outputs.${index}`;
    if (!OUTPUT_ID.test(output.id)) add(`${at}.id`, 'Use 1 to 64 letters, digits, dashes and underscores');
    else if (seen.has(output.id)) add(`${at}.id`, `Output id "${output.id}" is used twice`);
    seen.add(output.id);
    const parsed = OUTPUT_CONFIGS[output.kind].safeParse(output.config);
    if (!parsed.success) for (const issue of parsed.error.issues) add([at, 'config', ...issue.path.map(String)].join('.'), issue.message);
  });
  // Counted from the raw configs, so outputs that each parse can still be refused together.
  const recipients = definition.outputs.filter((o) => o.kind === 'email')
    .reduce((sum, o) => sum + (Array.isArray(o.config.recipients) ? o.config.recipients.length : 0), 0);
  if (recipients > MAX_RECIPIENTS_PER_ITEM) add('outputs', `At most ${MAX_RECIPIENTS_PER_ITEM} recipients across all email outputs`);
  return errors;
}

export const DeliveryStatus = z.enum(['pending', 'delivered', 'failed']);
/** GET /api/v1/teams/:teamId/items/:itemId/deliveries: one row per email or webhook output. */
export const DeliveryResponse = z.object({
  id: z.string(), outputId: z.string(), kind: z.enum(DELIVERED_KINDS), status: DeliveryStatus,
  attempts: z.number().int(), lastError: z.string().nullable(), nextAttemptAt: z.string(),
  deliveredAt: z.string().nullable(), updatedAt: z.string(),
});
/** POST /api/v1/teams/:teamId/work-types/:workTypeId/exports: the format; the export output's when absent. */
export const CreateExportRequest = z.object({ format: ExportFormat.optional() }).strict();
/** An export's metadata; the file itself is GET .../exports/:exportId/download. */
export const ExportResponse = z.object({
  id: z.string(), workTypeId: z.string(), format: ExportFormat, itemCount: z.number().int(), sizeBytes: z.number().int(),
  createdBySubject: z.string(), createdAt: z.string(),
});

export type DeliveryStatus = z.infer<typeof DeliveryStatus>;
export type DeliveryResponse = z.infer<typeof DeliveryResponse>;
export type CreateExportRequest = z.infer<typeof CreateExportRequest>;
export type ExportResponse = z.infer<typeof ExportResponse>;

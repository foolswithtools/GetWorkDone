// The domain contract (GWP#2; spec §4.3, D-028, D-048), copied from the issue. Later slices import it
// and never redefine it. The one change from the issue text: zod 4 (pinned 4.6.7) takes a record's key
// schema explicitly, so `z.record(z.unknown())` is written `z.record(z.string(), z.unknown())`.
import { z } from 'zod';
import { captureFieldProblems, MAX_DEFINITION_PATTERN_STATES, patternStates } from './capture.js';

export const FieldType = z.enum(['text', 'longtext', 'number', 'date', 'boolean', 'select', 'email', 'url']);
export const CaptureField = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), label: z.string().min(1).max(120),
  type: FieldType, required: z.boolean().default(false),
  options: z.array(z.string().min(1)).optional(), // select only
  min: z.number().optional(), max: z.number().optional(), pattern: z.string().optional(),
}).superRefine((field, ctx) => {
  // GWP#4: a field that could not be validated, or not safely (a catastrophic pattern), is refused at
  // definition time (capture.ts).
  for (const problem of captureFieldProblems(field)) ctx.addIssue({ code: 'custom', path: [problem.path], message: problem.message });
});
export const ProcessStep = z.discriminatedUnion('kind', [
  z.object({
    id: z.string(), name: z.string(), kind: z.literal('human'), assigneeRole: z.enum(['member', 'admin']),
    // GWP#54: what the person completing the step may decide, recorded on its step_completed event and
    // never branched on (D-028). Duplicates are refused by stepProblems (process.ts).
    decisions: z.array(z.string().min(1).max(40)).min(1).max(10).optional(),
  }),
  z.object({ id: z.string(), name: z.string(), kind: z.literal('automated'), transform: z.string(), params: z.record(z.string(), z.unknown()) }),
]);
export const OutputKind = z.enum(['none', 'persist', 'email', 'webhook', 'export']);
/** Outputs one definition may have (GWP#50): each completed item fans out to at most this many. */
export const MAX_OUTPUTS = 5;
export const DistributionOutput = z.object({ id: z.string(), kind: OutputKind, config: z.record(z.string(), z.unknown()) });
export const WorkTypeDefinition = z.object({
  fields: z.array(CaptureField).min(1),
  steps: z.array(ProcessStep), // array order is execution order
  outputs: z.array(DistributionOutput).min(1).max(MAX_OUTPUTS, `At most ${MAX_OUTPUTS} outputs`),
}).superRefine((definition, ctx) => {
  const duplicates = (values: string[]) => values.filter((value, index) => values.indexOf(value) !== index);
  for (const key of new Set(duplicates(definition.fields.map((f) => f.key)))) {
    ctx.addIssue({ code: 'custom', path: ['fields'], message: `duplicate field key "${key}"` });
  }
  for (const id of new Set(duplicates(definition.steps.map((s) => s.id)))) {
    ctx.addIssue({ code: 'custom', path: ['steps'], message: `duplicate step id "${id}"` });
  }
  // GWP#4: one item's validation stays bounded however many patterned fields there are (capture.ts).
  if (patternStates(definition.fields) > MAX_DEFINITION_PATTERN_STATES) {
    ctx.addIssue({ code: 'custom', path: ['fields'], message: 'The fields\' patterns are too complex together' });
  }
  // D-048: `none` clears captured data at completion, so it cannot sit beside an output that uses it.
  if (definition.outputs.length > 1 && definition.outputs.some((o) => o.kind === 'none')) {
    ctx.addIssue({ code: 'custom', path: ['outputs'], message: 'output `none` excludes every other output' });
  }
});
export const ItemStatus = z.enum(['open', 'in_progress', 'completed', 'failed', 'cancelled']);

export type FieldType = z.infer<typeof FieldType>;
export type CaptureField = z.infer<typeof CaptureField>;
export type ProcessStep = z.infer<typeof ProcessStep>;
export type OutputKind = z.infer<typeof OutputKind>;
export type DistributionOutput = z.infer<typeof DistributionOutput>;
export type WorkTypeDefinition = z.infer<typeof WorkTypeDefinition>;
export type ItemStatus = z.infer<typeof ItemStatus>;

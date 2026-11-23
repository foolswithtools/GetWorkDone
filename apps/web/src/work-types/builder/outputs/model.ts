// The output editor's state and the pure operations on it (GWP#6, docs/outputs.md). A draft output holds
// what is typed into its inputs; outputFromDraft turns it into the DistributionOutput that is saved, with
// only the settings its kind takes. The builder checks the result with the contract's outputProblems, so
// it shows the same errors the API would answer.

import type { DistributionOutput, ExportFormat, OutputKind } from '@getworkdone/contracts';

export interface DraftOutput {
  /** A stable id for React keys; never saved. */
  draftId: string;
  /** The saved output id, half of each delivery's idempotency key. */
  id: string;
  kind: OutputKind;
  /** Webhook: the https URL. */
  url: string;
  /** Webhook and email: the deadline per attempt in milliseconds, empty for the default. */
  deadline: string;
  /** Email: recipients, one per line or comma separated. */
  recipients: string;
  /** Email: the subject, empty for the default. */
  subject: string;
  /** Export: the default format. */
  format: ExportFormat;
}

/** What each kind does, for the editor's kind list. */
export const OUTPUT_KIND_TITLES: Record<OutputKind, string> = {
  persist: 'Keep the captured data',
  none: 'Clear the captured data when the item completes',
  webhook: 'POST each completed item to a URL',
  email: 'Email each completed item',
  export: 'Download completed items as CSV or JSON',
};

let nextId = 0;
const draftId = () => {
  nextId += 1;
  return `output-draft-${nextId}`;
};

/** A new output of `kind` with the first free `output_N` id. */
export function newOutput(existing: DraftOutput[], kind: OutputKind): DraftOutput {
  const ids = new Set(existing.map((o) => o.id));
  let n = 1;
  while (ids.has(`output_${n}`)) n += 1;
  return { draftId: draftId(), id: `output_${n}`, kind, url: '', deadline: '', recipients: '', subject: '', format: 'csv' };
}

export function updateOutput(outputs: DraftOutput[], index: number, change: Partial<DraftOutput>): DraftOutput[] {
  return outputs.map((output, i) => (i === index ? { ...output, ...change } : output));
}

export function removeOutput(outputs: DraftOutput[], index: number): DraftOutput[] {
  return outputs.filter((_, i) => i !== index);
}

const text = (value: unknown) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

/** A stored output as a draft, to edit an existing work type. */
export function draftFromOutput(output: DistributionOutput): DraftOutput {
  const config = output.config;
  return {
    draftId: draftId(), id: output.id, kind: output.kind, url: text(config.url), deadline: text(config.deadlineMs),
    recipients: Array.isArray(config.recipients) ? config.recipients.join('\n') : '', subject: text(config.subject),
    format: config.format === 'json' ? 'json' : 'csv',
  };
}

/** A deadline as typed: absent when empty, NaN when not a number (the check then refuses it). */
const deadline = (value: string): { deadlineMs?: number } => (value.trim() === '' ? {} : { deadlineMs: Number(value) });

/** The DistributionOutput a draft describes. */
export function outputFromDraft(draft: DraftOutput): DistributionOutput {
  switch (draft.kind) {
    case 'webhook':
      return { id: draft.id, kind: draft.kind, config: { url: draft.url.trim(), ...deadline(draft.deadline) } };
    case 'email': {
      const recipients = draft.recipients.split(/[\n,]/).map((r) => r.trim()).filter((r) => r !== '');
      return { id: draft.id, kind: draft.kind, config: { recipients, ...(draft.subject !== '' ? { subject: draft.subject } : {}), ...deadline(draft.deadline) } };
    }
    case 'export':
      return { id: draft.id, kind: draft.kind, config: { format: draft.format } };
    default:
      return { id: draft.id, kind: draft.kind, config: {} };
  }
}

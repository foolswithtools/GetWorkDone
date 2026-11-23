// The builder's state and the pure operations on it (GWP#4, docs/capture.md). The builder edits draft
// fields whose settings are the strings typed into its inputs; fieldFromDraft turns a draft into a
// CaptureField and buildDefinition into the WorkTypeDefinition that is saved as the next version. The
// definition is checked with the contract's own WorkTypeDefinition, so the builder shows the same
// definition-time errors (an unsafe pattern, a select without options) as the API would answer, and
// with the contract's stepProblems, the API's save-time step checks (GWP#5; steps/model.ts), and
// outputProblems, its output checks (GWP#6; outputs/model.ts).

import { FORM_ERROR_KEY, outputProblems, stepProblems, WorkTypeDefinition, type CaptureErrors, type CaptureField, type FieldType } from '@getworkdone/contracts';

export interface DraftField {
  /** A stable id for React keys and focus while fields move; never saved. */
  id: string;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** Select options, one per line or comma separated. */
  options: string;
  min: string;
  max: string;
  pattern: string;
}

const LIMITED = new Set<FieldType>(['text', 'longtext', 'number']);
const TEXT = new Set<FieldType>(['text', 'longtext']);
/** A new work type keeps its items (`persist`) until the output editor says otherwise. */
const DEFAULT_OUTPUTS: WorkTypeDefinition['outputs'] = [{ id: 'keep', kind: 'persist', config: {} }];

let nextId = 0;

/** A new text field with the first free `field_N` key. */
export function newDraftField(existing: DraftField[]): DraftField {
  const keys = new Set(existing.map((f) => f.key));
  let n = existing.length + 1;
  while (keys.has(`field_${n}`)) n += 1;
  nextId += 1;
  return { id: `draft-${nextId}`, key: `field_${n}`, label: `Field ${n}`, type: 'text', required: false, options: '', min: '', max: '', pattern: '' };
}

/** The field at `index` moved one place (`delta` -1 or 1); unchanged at either end. */
export function moveField(fields: DraftField[], index: number, delta: -1 | 1): DraftField[] {
  const target = index + delta;
  if (target < 0 || target >= fields.length) return fields;
  const next = [...fields];
  [next[index], next[target]] = [next[target] as DraftField, next[index] as DraftField];
  return next;
}

export function updateField(fields: DraftField[], index: number, change: Partial<DraftField>): DraftField[] {
  return fields.map((field, i) => (i === index ? { ...field, ...change } : field));
}

export function removeField(fields: DraftField[], index: number): DraftField[] {
  return fields.filter((_, i) => i !== index);
}

/** A limit as typed: absent when empty, NaN when not a number (the definition check then refuses it). */
const limit = (value: string): number | undefined => (value.trim() === '' ? undefined : Number(value));

/** The CaptureField a draft describes, with only the settings its type takes. */
export function fieldFromDraft(draft: DraftField): CaptureField {
  const field: CaptureField = { key: draft.key, label: draft.label, type: draft.type, required: draft.required };
  if (draft.type === 'select') field.options = draft.options.split(/[\n,]/).map((o) => o.trim()).filter((o) => o !== '');
  if (LIMITED.has(draft.type)) {
    const min = limit(draft.min);
    const max = limit(draft.max);
    if (min !== undefined) field.min = min;
    if (max !== undefined) field.max = max;
  }
  if (TEXT.has(draft.type) && draft.pattern !== '') field.pattern = draft.pattern;
  return field;
}

/** A stored field as a draft, to edit an existing work type. */
export function draftFromField(field: CaptureField): DraftField {
  nextId += 1;
  return {
    id: `draft-${nextId}`, key: field.key, label: field.label, type: field.type, required: field.required,
    options: (field.options ?? []).join('\n'), min: field.min === undefined ? '' : String(field.min),
    max: field.max === undefined ? '' : String(field.max), pattern: field.pattern ?? '',
  };
}

/**
 * The definition to save: the drafts as fields, the step editor's steps and the output editor's outputs
 * (the stored ones, or a new work type's default, when none are given).
 */
export function buildDefinition(drafts: DraftField[], base?: WorkTypeDefinition, steps?: WorkTypeDefinition['steps'], outputs?: WorkTypeDefinition['outputs']): WorkTypeDefinition {
  return { fields: drafts.map(fieldFromDraft), steps: steps ?? base?.steps ?? [], outputs: outputs ?? base?.outputs ?? DEFAULT_OUTPUTS };
}

/** The outputs a new work type starts with. */
export function defaultOutputs(): WorkTypeDefinition['outputs'] {
  return DEFAULT_OUTPUTS;
}

/**
 * The contract's complaints about a definition, keyed by dotted path (`fields.0.pattern`,
 * `steps.1.params.field`); empty when valid. The step checks run once the definition itself parses.
 */
export function definitionErrors(definition: WorkTypeDefinition): CaptureErrors {
  const result = WorkTypeDefinition.safeParse(definition);
  if (result.success) return { ...stepProblems(result.data), ...outputProblems(result.data) };
  const errors: CaptureErrors = {};
  for (const issue of result.error.issues) (errors[issue.path.length > 0 ? issue.path.join('.') : FORM_ERROR_KEY] ??= []).push(issue.message);
  return errors;
}

// The step editor's state and the pure operations on it (GWP#5, docs/process.md). A draft step holds
// what is typed into its inputs; stepFromDraft turns it into the ProcessStep that is saved. An automated
// step's parameter form is generated from its transform's Zod params (TRANSFORM_PARAMS in the
// contract) with describeParams, and the builder checks the result with the contract's stepProblems,
// so it shows the same errors the API would answer.

import { describeParams, TRANSFORM_PARAMS, type CaptureField, type ParamSpec, type ProcessStep, type TeamRole } from '@getworkdone/contracts';

export interface DraftStep {
  /** A stable id for React keys and focus while steps move; never saved. */
  draftId: string;
  /** The saved step id, unique in the definition. */
  id: string;
  name: string;
  kind: ProcessStep['kind'];
  assigneeRole: TeamRole;
  /** A human step's decisions as typed, one per line (GWP#54); blank lines are dropped on save. */
  decisions: string;
  transform: string;
  /** The parameter form's inputs as typed: text per input, a list of field keys for a `fields` param. */
  inputs: Record<string, string | string[]>;
  /** The stored params of a transform the editor does not know, kept so saving reports it. */
  storedParams?: Record<string, unknown>;
}

const known = (transform: string): transform is keyof typeof TRANSFORM_PARAMS => Object.hasOwn(TRANSFORM_PARAMS, transform);

let nextId = 0;
const draftId = () => {
  nextId += 1;
  return `step-draft-${nextId}`;
};

/** A new step with the first free `step_N` id: a human step for members, or a set_field step. */
export function newStep(existing: DraftStep[], kind: ProcessStep['kind']): DraftStep {
  const ids = new Set(existing.map((s) => s.id));
  let n = 1;
  while (ids.has(`step_${n}`)) n += 1;
  return { draftId: draftId(), id: `step_${n}`, name: '', kind, assigneeRole: 'member', decisions: '', transform: 'set_field', inputs: {} };
}

/** The step at `index` moved one place (`delta` -1 or 1); unchanged at either end. */
export function moveStep(steps: DraftStep[], index: number, delta: -1 | 1): DraftStep[] {
  const target = index + delta;
  if (target < 0 || target >= steps.length) return steps;
  const next = [...steps];
  [next[index], next[target]] = [next[target] as DraftStep, next[index] as DraftStep];
  return next;
}

export function updateStep(steps: DraftStep[], index: number, change: Partial<DraftStep>): DraftStep[] {
  return steps.map((step, i) => (i === index ? { ...step, ...change } : step));
}

export function removeStep(steps: DraftStep[], index: number): DraftStep[] {
  return steps.filter((_, i) => i !== index);
}

/** Another transform takes other params: the old inputs are dropped. */
export function changeTransform(step: DraftStep, transform: string): DraftStep {
  const next: DraftStep = { ...step, transform, inputs: {} };
  delete next.storedParams;
  return next;
}

/** The parameter form of `transform`: one input per param, in order; none for an unknown transform. */
export function inputsFor(transform: string): ParamSpec[] {
  return known(transform) ? describeParams(TRANSFORM_PARAMS[transform]) : [];
}

/** The fields a field param may name: those of the types it takes. */
export function fieldsFor(spec: ParamSpec, fields: CaptureField[]): CaptureField[] {
  const types = spec.kind === 'field' || spec.kind === 'fields' ? spec.fieldTypes : undefined;
  return types ? fields.filter((f) => types.includes(f.type)) : fields;
}

/** A constant as typed, in its field's type: a number field's number, a boolean field's true or false. */
function constant(text: string, field: CaptureField | undefined): unknown {
  if (field?.type === 'number') {
    const value = Number(text);
    // Not a number: kept as typed, so the contract reports it against the field.
    return text.trim() !== '' && Number.isFinite(value) ? value : text;
  }
  if (field?.type === 'boolean' && (text === 'true' || text === 'false')) return text === 'true';
  return text;
}

/**
 * A human step's decisions from its lines, trimmed, blank ones dropped; undefined when there are none.
 * Duplicates are kept, so the contract's stepProblems refuses them at save (GWP#54).
 */
function decisionsFrom(text: string): string[] | undefined {
  const decisions = text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return decisions.length > 0 ? decisions : undefined;
}

/** The ProcessStep a draft describes. Empty inputs are left out, so the contract reports them. */
export function stepFromDraft(draft: DraftStep, fields: CaptureField[]): ProcessStep {
  if (draft.kind === 'human') {
    const decisions = decisionsFrom(draft.decisions);
    return { id: draft.id, name: draft.name, kind: 'human', assigneeRole: draft.assigneeRole, ...(decisions ? { decisions } : {}) };
  }
  if (!known(draft.transform)) return { id: draft.id, name: draft.name, kind: 'automated', transform: draft.transform, params: draft.storedParams ?? {} };
  const params: Record<string, unknown> = {};
  for (const spec of inputsFor(draft.transform)) {
    const input = draft.inputs[spec.name];
    if (spec.kind === 'fields') {
      params[spec.name] = Array.isArray(input) ? input : [];
      continue;
    }
    const text = typeof input === 'string' ? input : '';
    if (text === '') continue;
    if (spec.kind === 'value') {
      const target = draft.inputs[spec.of];
      params[spec.name] = constant(text, fields.find((f) => f.key === target));
    } else {
      params[spec.name] = text;
    }
  }
  return { id: draft.id, name: draft.name, kind: 'automated', transform: draft.transform, params };
}

/** A stored step as a draft, to edit an existing work type. */
export function draftFromStep(step: ProcessStep): DraftStep {
  const base = { draftId: draftId(), id: step.id, name: step.name, kind: step.kind, assigneeRole: 'member' as TeamRole, decisions: '', transform: 'set_field', inputs: {} };
  if (step.kind === 'human') return { ...base, assigneeRole: step.assigneeRole, decisions: (step.decisions ?? []).join('\n') };
  if (!known(step.transform)) return { ...base, transform: step.transform, storedParams: step.params };
  const inputs: DraftStep['inputs'] = {};
  for (const spec of inputsFor(step.transform)) {
    const value = step.params[spec.name];
    if (value === undefined) continue;
    inputs[spec.name] = spec.kind === 'fields' && Array.isArray(value) ? value.map(String) : String(value);
  }
  return { ...base, transform: step.transform, inputs };
}

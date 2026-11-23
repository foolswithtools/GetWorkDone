// The transform registry (GWP#5, D-028; docs/process.md): the deterministic functions automated steps
// run. No LLM and no I/O: each transform takes the item's data and its parsed params and returns the
// new data, without touching its input. The params schemas are the contract's (TRANSFORM_PARAMS in
// @getworkdone/contracts), so the builder's step editor generates its forms from the same schemas.
import {
  ArithmeticParams, CopyFieldParams, RequireFieldsParams, SetFieldParams, StringCaseParams, validateCapture,
  type CaptureErrors, type CaptureField, type ProcessStep,
} from '@getworkdone/contracts';
import type { z } from 'zod';

export interface TransformContext { data: Readonly<Record<string, unknown>>; fields: readonly CaptureField[] }
export interface Transform<P> {
  readonly name: string;
  readonly params: z.ZodType<P>;
  apply(ctx: TransformContext, params: P): Record<string, unknown>; // returns the new data; pure, no I/O
}

/** Thrown by a transform to fail its step; the message is the reason recorded in `step_failed`. */
export class TransformFailure extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TransformFailure';
  }
}

/** `data` with `key` removed; a new object. */
function without(data: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([k]) => k !== key));
}

function numberAt(data: Readonly<Record<string, unknown>>, key: string): number {
  const value = data[key];
  if (value === undefined || value === null) throw new TransformFailure(`Field "${key}" is empty`);
  if (typeof value !== 'number') throw new TransformFailure(`Field "${key}" is not a number`);
  return value;
}

/** Empty for require_fields: absent, null, or text that is blank once trimmed. */
const isEmpty = (value: unknown) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

const setField: Transform<SetFieldParams> = {
  name: 'set_field',
  params: SetFieldParams,
  apply: ({ data }, { field, value }) => ({ ...data, [field]: value }),
};

const copyField: Transform<CopyFieldParams> = {
  name: 'copy_field',
  params: CopyFieldParams,
  apply: ({ data }, { from, to }) => (data[from] === undefined ? without(data, to) : { ...data, [to]: data[from] }),
};

const CASES = { upper: (s: string) => s.toUpperCase(), lower: (s: string) => s.toLowerCase(), trim: (s: string) => s.trim() };
const stringCase: Transform<StringCaseParams> = {
  name: 'string_case',
  params: StringCaseParams,
  apply: ({ data }, { field, op }) => {
    const value = data[field];
    if (value === undefined) return { ...data };
    if (typeof value !== 'string') throw new TransformFailure(`Field "${field}" is not text`);
    return { ...data, [field]: CASES[op](value) };
  },
};

const OPERATIONS = { add: (a: number, b: number) => a + b, subtract: (a: number, b: number) => a - b, multiply: (a: number, b: number) => a * b };
const arithmetic: Transform<ArithmeticParams> = {
  name: 'arithmetic',
  params: ArithmeticParams,
  apply: ({ data }, { op, left, right, into }) => {
    const result = OPERATIONS[op](numberAt(data, left), numberAt(data, right));
    if (!Number.isFinite(result)) throw new TransformFailure('The result is not a finite number');
    return { ...data, [into]: result };
  },
};

const requireFields: Transform<RequireFieldsParams> = {
  name: 'require_fields',
  params: RequireFieldsParams,
  apply: ({ data }, { fields }) => {
    const empty = fields.filter((key) => isEmpty(data[key]));
    if (empty.length > 0) throw new TransformFailure(`Required fields are empty: ${empty.join(', ')}`);
    return { ...data };
  },
};

export const TRANSFORMS: ReadonlyMap<string, Transform<unknown>> = new Map(
  [setField, copyField, stringCase, arithmetic, requireFields].map((t) => [t.name, t as Transform<unknown>]),
);

export type StepOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; reason: string; errors?: CaptureErrors };

/**
 * Runs an automated step over `data`: the transform's params are parsed again (the stored definition
 * was checked at save, but is not re-parsed when read), the transform is applied, and its output is
 * re-validated with validateCapture. Never throws: every failure is the step's outcome.
 */
export function runTransform(step: Extract<ProcessStep, { kind: 'automated' }>, data: Record<string, unknown>, fields: readonly CaptureField[], registry: ReadonlyMap<string, Transform<unknown>> = TRANSFORMS): StepOutcome {
  const transform = registry.get(step.transform);
  if (!transform) return { ok: false, reason: `Unknown transform "${step.transform}"` };
  const params = transform.params.safeParse(step.params);
  if (!params.success) return { ok: false, reason: 'The step\'s params are invalid', errors: { params: params.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`) } };
  let output: Record<string, unknown>;
  try {
    output = transform.apply({ data, fields }, params.data);
  } catch (error) {
    return { ok: false, reason: error instanceof TransformFailure ? error.message : `Transform "${step.transform}" failed unexpectedly` };
  }
  const checked = validateCapture([...fields], output);
  return checked.ok ? { ok: true, data: checked.data } : { ok: false, reason: 'The result does not pass the work type\'s validation', errors: checked.errors };
}

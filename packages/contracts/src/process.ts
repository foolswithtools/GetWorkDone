// Process step parameters (GWP#5, D-028; docs/process.md). Each v1 transform's params are a Zod object
// defined here, so the API's transform registry (apps/api/src/modules/process/transforms.ts) and the
// builder's step editor share one schema: the editor generates its parameter form from the schema with
// describeParams, and both run stepProblems, the save-time checks, over a definition's steps.
import { z } from 'zod';
import { validateCapture, type CaptureErrors } from './capture.js';
import type { CaptureField, FieldType, WorkTypeDefinition } from './domain.js';

const FIELD_KEY = /^[a-z][a-z0-9_]{0,62}$/;
/** A step id is a URL path segment (`.../steps/:stepId/complete`): never empty, `.`, `..` or a slash. */
const STEP_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A param naming one of the definition's fields, optionally only of `fieldTypes`. The metadata goes on
 * this innermost schema: wrap it (`.optional()`, `z.array(...)`) after, never before.
 */
export function fieldRef(title: string, fieldTypes?: FieldType[]) {
  return z.string().regex(FIELD_KEY, 'Choose a field').meta({ title, fieldRef: true, ...(fieldTypes ? { fieldTypes } : {}) });
}

const Scalar = z.union([z.string(), z.number(), z.boolean()]);

export const SetFieldParams = z.object({
  field: fieldRef('Field'),
  /** Must be a valid value for `field` (stepProblems checks it with validateCapture). */
  value: Scalar.meta({ title: 'Value', valueOf: 'field' }),
}).strict();
export const CopyFieldParams = z.object({ from: fieldRef('From field'), to: fieldRef('To field') }).strict();
export const StringCaseParams = z.object({
  field: fieldRef('Field', ['text', 'longtext']),
  op: z.enum(['upper', 'lower', 'trim']).meta({ title: 'Change' }),
}).strict();
export const ArithmeticParams = z.object({
  op: z.enum(['add', 'subtract', 'multiply']).meta({ title: 'Operation' }),
  left: fieldRef('Left operand', ['number']),
  right: fieldRef('Right operand', ['number']),
  into: fieldRef('Result field', ['number']),
}).strict();
export const RequireFieldsParams = z.object({ fields: z.array(fieldRef('Field')).min(1).meta({ title: 'Fields' }) }).strict();

/** The v1 transforms' params, by transform name; the API's TRANSFORMS has exactly these names. */
export const TRANSFORM_PARAMS = {
  set_field: SetFieldParams,
  copy_field: CopyFieldParams,
  string_case: StringCaseParams,
  arithmetic: ArithmeticParams,
  require_fields: RequireFieldsParams,
} as const;
export type TransformName = keyof typeof TRANSFORM_PARAMS;
export const TRANSFORM_NAMES = Object.keys(TRANSFORM_PARAMS) as TransformName[];

/** What each transform does, for the step editor. */
export const TRANSFORM_TITLES: Record<TransformName, string> = {
  set_field: 'Set a field to a value',
  copy_field: 'Copy one field to another',
  string_case: 'Change the case of a text field, or trim it',
  arithmetic: 'Add, subtract or multiply two number fields',
  require_fields: 'Fail unless the fields have values',
};

export type SetFieldParams = z.infer<typeof SetFieldParams>;
export type CopyFieldParams = z.infer<typeof CopyFieldParams>;
export type StringCaseParams = z.infer<typeof StringCaseParams>;
export type ArithmeticParams = z.infer<typeof ArithmeticParams>;
export type RequireFieldsParams = z.infer<typeof RequireFieldsParams>;

/** One input of a transform's parameter form. */
export type ParamSpec = { name: string; title: string; optional: boolean } & (
  | { kind: 'field'; fieldTypes?: FieldType[] }
  | { kind: 'fields'; fieldTypes?: FieldType[] }
  | { kind: 'choice'; options: string[] }
  /** A constant whose type follows the field named by param `of`. */
  | { kind: 'value'; of: string }
);

interface ParamMeta { title?: string; fieldRef?: boolean; fieldTypes?: FieldType[]; valueOf?: string }
const metaOf = (schema: z.ZodType): ParamMeta => (schema.meta() ?? {}) as unknown as ParamMeta;
const withTypes = (meta: ParamMeta) => (meta.fieldTypes ? { fieldTypes: meta.fieldTypes } : {});

/**
 * A params schema as form inputs, one per key in order. Only the shapes the transforms use are
 * understood: a field reference, an array of field references, an enum and a constant tied to a field,
 * each optionally optional; anything else throws, so a new transform cannot ship a form that drops a param.
 */
export function describeParams(schema: z.ZodType): ParamSpec[] {
  if (!(schema instanceof z.ZodObject)) throw new Error('params must be an object');
  return Object.entries(schema.shape as Record<string, z.ZodType>).map(([name, entry]) => {
    const optional = entry instanceof z.ZodOptional;
    const inner = optional ? (entry as z.ZodOptional<z.ZodType>).unwrap() : entry;
    const meta = metaOf(inner);
    const base = { name, title: meta.title ?? name, optional };
    if (inner instanceof z.ZodString && meta.fieldRef) return { ...base, kind: 'field', ...withTypes(meta) };
    if (inner instanceof z.ZodArray) {
      const element = metaOf((inner as z.ZodArray<z.ZodType>).element);
      if (element.fieldRef) return { ...base, kind: 'fields', ...withTypes(element) };
    }
    if (inner instanceof z.ZodEnum) return { ...base, kind: 'choice', options: (inner.options as string[]).map(String) };
    if (inner instanceof z.ZodUnion && meta.valueOf) return { ...base, kind: 'value', of: meta.valueOf };
    throw new Error(`param "${name}" has a shape the form cannot render`);
  });
}

/** What stepProblems needs of a transform: its params schema. The API passes its TRANSFORMS. */
export interface TransformParamsEntry { readonly params: z.ZodType }

const CONTRACT_REGISTRY: ReadonlyMap<string, TransformParamsEntry> = new Map(Object.entries(TRANSFORM_PARAMS).map(([name, params]) => [name, { params }]));

function fieldProblem(field: CaptureField | undefined, key: string, fieldTypes: FieldType[] | undefined): string | undefined {
  if (!field) return `No field "${key}" in this work type`;
  if (fieldTypes && !fieldTypes.includes(field.type)) return `Must be a field of type ${fieldTypes.join(' or ')}`;
  return undefined;
}

/** The most decisions a human step lists, and the longest one (GWP#54; the contract's ProcessStep bounds). */
export const MAX_DECISIONS = 10;
export const MAX_DECISION_LENGTH = 40;

/** A human step's decisions: 1 to 10, each 1 to 40 characters, no two alike (GWP#54). */
function decisionProblems(decisions: readonly string[]): string[] {
  const problems: string[] = [];
  if (decisions.length < 1 || decisions.length > MAX_DECISIONS) problems.push(`Give 1 to ${MAX_DECISIONS} decisions`);
  if (decisions.some((d) => d.length < 1 || d.length > MAX_DECISION_LENGTH)) problems.push(`Each decision is 1 to ${MAX_DECISION_LENGTH} characters`);
  for (const decision of new Set(decisions.filter((d, i) => decisions.indexOf(d) !== i))) problems.push(`Duplicate decision "${decision}"`);
  return problems;
}

/**
 * The save-time checks on a definition's automated steps, keyed by dotted path like the builder's
 * errors (`steps.0.transform`, `steps.0.params.field`); empty when there are none. Every step id must
 * be usable as a path segment, and a human step's decisions are 1 to 10 distinct texts of 1 to 40
 * characters, refused at `steps.N.decisions`. A transform must be in `registry`, its params must parse, every field
 * they name must be in the definition (of the right type where the param says), and a constant must be
 * a valid value for its field.
 */
export function stepProblems(definition: WorkTypeDefinition, registry: ReadonlyMap<string, TransformParamsEntry> = CONTRACT_REGISTRY): CaptureErrors {
  const errors: CaptureErrors = {};
  const add = (path: string, message: string) => (errors[path] ??= []).push(message);
  const fields = new Map(definition.fields.map((f) => [f.key, f]));
  definition.steps.forEach((step, index) => {
    const at = `steps.${index}`;
    if (!STEP_ID.test(step.id)) add(`${at}.id`, 'Use 1 to 64 letters, digits, dashes and underscores');
    if (step.kind === 'human') {
      if (step.decisions) for (const message of decisionProblems(step.decisions)) add(`${at}.decisions`, message);
      return;
    }
    const entry = registry.get(step.transform);
    if (!entry) return add(`${at}.transform`, `Unknown transform "${step.transform}"`);
    const parsed = entry.params.safeParse(step.params);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) add([at, 'params', ...issue.path.map(String)].join('.'), issue.message);
      return;
    }
    const params = parsed.data as Record<string, unknown>;
    for (const spec of describeParams(entry.params)) {
      const value = params[spec.name];
      const path = `${at}.params.${spec.name}`;
      if (value === undefined) continue;
      if (spec.kind === 'field' || spec.kind === 'fields') {
        for (const key of spec.kind === 'field' ? [value as string] : (value as string[])) {
          const problem = fieldProblem(fields.get(key), key, spec.fieldTypes);
          if (problem) add(path, problem);
        }
      } else if (spec.kind === 'value') {
        const target = fields.get(params[spec.of] as string);
        if (!target) continue;
        const result = validateCapture([{ ...target, required: false }], { [target.key]: value });
        if (!result.ok) for (const message of result.errors[target.key] ?? []) add(path, message);
      }
    }
  });
  return errors;
}

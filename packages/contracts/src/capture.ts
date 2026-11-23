// Capture validation generated from a work type's fields (GWP#4, D-028; docs/capture.md). The browser
// checks a capture form with validateCapture before it submits, and the API checks the submitted item
// with the same call, so both sides show the same messages for the same input. captureFieldProblems
// holds the definition-time checks (CaptureField in domain.ts runs them), so a field that could not be
// validated safely, such as a catastrophic pattern, is never stored.
import { z } from 'zod';
import type { CaptureField } from './domain.js';
import { analysePattern, compilePattern, MAX_STATES, type CompiledPattern } from './pattern-matcher.js';
import { PATTERNED_VALUE_MAX_LENGTH, patternProblem } from './safe-pattern.js';

export { PATTERNED_VALUE_MAX_LENGTH };

/** Field key -> messages. A key that is not a field (an unknown key) carries its own messages. */
export type CaptureErrors = Record<string, string[]>;

/**
 * The most matcher states all of a definition's patterns may compile to together, so one item's
 * validation is bounded however many patterned fields a work type has.
 */
export const MAX_DEFINITION_PATTERN_STATES = 4 * MAX_STATES;

/** The key for errors about the input as a whole; field keys start with a letter, so it never clashes. */
export const FORM_ERROR_KEY = '_form';
export const PATTERN_MAX_LENGTH = 200;

const LIMITED_TYPES = new Set(['text', 'longtext', 'number']);
const TEXT_TYPES = new Set(['text', 'longtext']);

/** A type error says "Required" when the value is absent, otherwise `message`. */
const typeError = (message: string) => ({ error: (issue: { input?: unknown }) => (issue.input === undefined ? 'Required' : message) });

type CheckedPattern = { states: number; problem?: undefined } | { states?: undefined; problem: string };

/**
 * A pattern checked as at definition time: it must be a valid regular expression, pass the safe-pattern
 * policy (safe-pattern.ts) and be accepted by the linear-time matcher (pattern-matcher.ts), which is what
 * runs it; patterns never run on RegExp. Linear in the pattern's length: nothing is compiled here.
 */
function checkPattern(pattern: string): CheckedPattern {
  if (pattern.length > PATTERN_MAX_LENGTH) return { problem: `Pattern must be at most ${PATTERN_MAX_LENGTH} characters` };
  try {
    new RegExp(`^(?:${pattern})$`);
  } catch {
    return { problem: 'Pattern is not a valid regular expression' };
  }
  const policy = patternProblem(pattern);
  if (policy) return { problem: policy };
  const analysed = analysePattern(pattern);
  return analysed.ok ? { states: analysed.states } : { problem: analysed.problem };
}

/** The matcher for a pattern that passes checkPattern; undefined for one that does not. */
function matcherFor(pattern: string): CompiledPattern | undefined {
  if (checkPattern(pattern).problem !== undefined) return undefined;
  const compiled = compilePattern(pattern);
  return compiled.ok ? compiled : undefined;
}

/** The matcher states of all of `fields`' acceptable patterns together. */
export function patternStates(fields: CaptureField[]): number {
  return fields.reduce((total, field) => total + (field.pattern === undefined ? 0 : (checkPattern(field.pattern).states ?? 0)), 0);
}

/** `budget.left` is the matcher states the definition's patterns may still use; a field over it is refused. */
function textSchema(field: CaptureField, budget: { left: number }): z.ZodType {
  let schema = z.string(typeError('Must be text'))
    .refine((value) => value !== '', { message: field.required ? 'Required' : 'Must not be empty; leave the field out instead', abort: true });
  const max = field.pattern === undefined ? field.max : Math.min(field.max ?? PATTERNED_VALUE_MAX_LENGTH, PATTERNED_VALUE_MAX_LENGTH);
  const { min } = field;
  if (min !== undefined) schema = schema.refine((value) => value.length >= min, `Must be at least ${min} characters`);
  if (max !== undefined) schema = schema.refine((value) => value.length <= max, { message: `Must be at most ${max} characters`, abort: true });
  if (field.pattern !== undefined) {
    // Only what the definition's budget allows is compiled (states are counted before building).
    const { states } = checkPattern(field.pattern);
    const affordable = states !== undefined && states <= budget.left;
    if (affordable) budget.left -= states;
    const matcher = affordable ? matcherFor(field.pattern) : undefined;
    // The whole value must match, as in an HTML pattern attribute. A stored pattern that fails the
    // definition-time checks (written before a check existed) is never run.
    schema = matcher
      ? schema.refine((value) => matcher.match(value), 'Does not match the expected format')
      : schema.refine(() => false, 'This field cannot be checked: its pattern is unsafe. Ask a team admin to fix the work type.');
  }
  return schema;
}

function numberSchema(field: CaptureField): z.ZodType {
  // z.number() refuses NaN and the infinities.
  let schema = z.number(typeError('Must be a number'));
  if (field.min !== undefined) schema = schema.min(field.min, `Must be at least ${field.min}`);
  if (field.max !== undefined) schema = schema.max(field.max, `Must be at most ${field.max}`);
  return schema;
}

function fieldSchema(field: CaptureField, budget: { left: number }): z.ZodType {
  switch (field.type) {
    case 'text':
    case 'longtext':
      return textSchema(field, budget);
    case 'number':
      return numberSchema(field);
    case 'date':
      return z.iso.date(typeError('Must be a date (YYYY-MM-DD)'));
    case 'boolean':
      return z.boolean(typeError('Must be true or false'));
    case 'select': {
      const options = field.options ?? [];
      return z.enum(options as [string, ...string[]], typeError(`Must be one of: ${options.join(', ')}`));
    }
    case 'email':
      return z.email(typeError('Must be an email address'));
    case 'url':
      return z.url({ protocol: /^https?$/, ...typeError('Must be an http or https URL') });
  }
}

/** The Zod schema for an item's data: one key per field, optional fields may be left out, no other keys. */
export function buildCaptureSchema(fields: CaptureField[]): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodType> = {};
  const budget = { left: MAX_DEFINITION_PATTERN_STATES };
  for (const field of fields) {
    const schema = fieldSchema(field, budget);
    shape[field.key] = field.required ? schema : schema.optional();
  }
  return z.object(shape, { error: (issue) => (issue.code === 'invalid_type' ? 'Must be an object of field values' : undefined) }).strict();
}

/** The issues of a failed parse, keyed by field (or by the unknown key, or FORM_ERROR_KEY). */
export function toCaptureErrors(error: z.ZodError): CaptureErrors {
  const errors: CaptureErrors = {};
  const add = (key: string, message: string) => (errors[key] ??= []).push(message);
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') for (const key of issue.keys) add(key, 'Unknown field');
    else add(issue.path.length > 0 ? String(issue.path[0]) : FORM_ERROR_KEY, issue.message);
  }
  return errors;
}

export type CaptureResult = { ok: true; data: Record<string, unknown> } | { ok: false; errors: CaptureErrors };
export type CaptureValidator = (input: unknown) => CaptureResult;

/**
 * A reusable validator for a version's fields: its patterns are compiled once, here, and every call
 * reuses them (the API keeps one per version, GWP#21).
 */
export function captureValidator(fields: CaptureField[]): CaptureValidator {
  const schema = buildCaptureSchema(fields);
  return (input) => {
    const result = schema.safeParse(input);
    return result.success ? { ok: true, data: result.data } : { ok: false, errors: toCaptureErrors(result.error) };
  };
}

/** Validate an item's data against a version's fields. */
export function validateCapture(fields: CaptureField[], input: unknown): CaptureResult {
  return captureValidator(fields)(input);
}

export interface FieldProblem { path: 'pattern' | 'options' | 'min' | 'max'; message: string }

const isLength = (value: number | undefined) => value === undefined || (Number.isInteger(value) && value >= 0);

/** Definition-time checks of one field: a field that fails them could not be validated, or not safely. */
export function captureFieldProblems(field: CaptureField): FieldProblem[] {
  const problems: FieldProblem[] = [];
  if (field.pattern !== undefined) {
    if (!TEXT_TYPES.has(field.type)) problems.push({ path: 'pattern', message: 'Only text and longtext fields take a pattern' });
    else {
      const { problem } = checkPattern(field.pattern);
      if (problem) problems.push({ path: 'pattern', message: problem });
    }
    if (field.max !== undefined && field.max > PATTERNED_VALUE_MAX_LENGTH) {
      problems.push({ path: 'max', message: `A field with a pattern takes at most ${PATTERNED_VALUE_MAX_LENGTH} characters` });
    }
  }
  if (field.type === 'select') {
    if (!field.options || field.options.length === 0) problems.push({ path: 'options', message: 'A select field needs at least one option' });
    else if (new Set(field.options).size !== field.options.length) problems.push({ path: 'options', message: 'Options must be distinct' });
  } else if (field.options !== undefined) {
    problems.push({ path: 'options', message: 'Only select fields take options' });
  }
  if (field.min !== undefined || field.max !== undefined) {
    if (!LIMITED_TYPES.has(field.type)) problems.push({ path: 'min', message: 'Only text, longtext and number fields take limits' });
    else if (TEXT_TYPES.has(field.type) && !isLength(field.min)) problems.push({ path: 'min', message: 'A length must be a whole number, 0 or more' });
    else if (TEXT_TYPES.has(field.type) && !isLength(field.max)) problems.push({ path: 'max', message: 'A length must be a whole number, 0 or more' });
    else if (field.min !== undefined && field.max !== undefined && field.min > field.max) problems.push({ path: 'min', message: 'Minimum must not be greater than maximum' });
  }
  return problems;
}

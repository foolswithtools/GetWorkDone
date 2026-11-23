import { describe, expect, it } from 'vitest';
import { buildCaptureSchema, captureFieldProblems, FORM_ERROR_KEY, MAX_DEFINITION_PATTERN_STATES, PATTERNED_VALUE_MAX_LENGTH, validateCapture } from '../src/capture.js';
import { CaptureField, WorkTypeDefinition, type CaptureField as Field } from '../src/domain.js';
import { patternProblem } from '../src/safe-pattern.js';
import { budget } from './time-budget.js';

const field = (over: Partial<Field> & Pick<Field, 'type'>): Field => ({ key: 'f', label: 'F', required: true, ...over });
const accepts = (f: Field, value: unknown) => validateCapture([f], { f: value }).ok;
const errorsFor = (fields: Field[], input: unknown) => {
  const result = validateCapture(fields, input);
  if (result.ok) throw new Error('expected a rejection');
  return result.errors;
};

describe('validateCapture: one accept and one reject per field type', () => {
  const cases: [string, Field, unknown, unknown, string][] = [
    ['text', field({ type: 'text', min: 2, max: 5 }), 'abc', 'a', 'Must be at least 2 characters'],
    ['text (max)', field({ type: 'text', max: 3 }), 'abc', 'abcd', 'Must be at most 3 characters'],
    ['text (pattern)', field({ type: 'text', pattern: '[A-Z]{3}-\\d+' }), 'ABC-12', 'ABC-12x', 'Does not match the expected format'],
    ['longtext', field({ type: 'longtext', max: 10 }), 'one\ntwo', 'x'.repeat(11), 'Must be at most 10 characters'],
    ['number', field({ type: 'number', min: 1, max: 10 }), 2.5, 11, 'Must be at most 10'],
    ['number (min)', field({ type: 'number', min: 1 }), 1, 0, 'Must be at least 1'],
    ['number (not finite)', field({ type: 'number' }), -3, Number.POSITIVE_INFINITY, 'Must be a number'],
    ['date', field({ type: 'date' }), '2026-10-21', '2026-13-01', 'Must be a date (YYYY-MM-DD)'],
    ['boolean', field({ type: 'boolean' }), false, 'true', 'Must be true or false'],
    ['select', field({ type: 'select', options: ['low', 'high'] }), 'high', 'medium', 'Must be one of: low, high'],
    ['email', field({ type: 'email' }), 'a@example.test', 'not-an-email', 'Must be an email address'],
    ['url', field({ type: 'url' }), 'https://example.test/x', 'not a url', 'Must be an http or https URL'],
  ];

  it.each(cases)('%s', (_name, f, good, bad, message) => {
    expect(accepts(f, good)).toBe(true);
    expect(errorsFor([f], { f: bad })).toEqual({ f: [message] });
  });

  it('a number given as a string is not coerced', () => {
    expect(errorsFor([field({ type: 'number' })], { f: '3' })).toEqual({ f: ['Must be a number'] });
  });

  it('a url must be http or https', () => {
    expect(errorsFor([field({ type: 'url' })], { f: 'javascript:alert(1)' })).toEqual({ f: ['Must be an http or https URL'] });
  });

  it('a required text field rejects the empty string', () => {
    expect(errorsFor([field({ type: 'text' })], { f: '' })).toEqual({ f: ['Required'] });
  });
});

describe('validateCapture: presence', () => {
  it('a missing required field is keyed by its field key', () => {
    const fields = [field({ key: 'title', type: 'text' }), field({ key: 'done', type: 'boolean' })];
    expect(errorsFor(fields, {})).toEqual({ title: ['Required'], done: ['Required'] });
  });

  it('optional fields accept absence and return only what was given', () => {
    const fields = [field({ key: 'title', type: 'text' }), field({ key: 'n', type: 'number', required: false })];
    expect(validateCapture(fields, { title: 'x' })).toEqual({ ok: true, data: { title: 'x' } });
  });

  it('an empty string on an optional number is rejected', () => {
    expect(errorsFor([field({ type: 'number', required: false })], { f: '' })).toEqual({ f: ['Must be a number'] });
  });

  it('an empty string on an optional text field is rejected: leave the key out instead', () => {
    expect(errorsFor([field({ type: 'text', required: false })], { f: '' })).toEqual({ f: ['Must not be empty; leave the field out instead'] });
  });

  it('null is not absence', () => {
    expect(errorsFor([field({ type: 'text', required: false })], { f: null })).toEqual({ f: ['Must be text'] });
  });

  it('.strict() rejects an extra key, keyed by that key', () => {
    expect(errorsFor([field({ type: 'text' })], { f: 'x', extra: 1, other: 2 })).toEqual({ extra: ['Unknown field'], other: ['Unknown field'] });
  });

  it('input that is not an object is a form-level error', () => {
    expect(errorsFor([field({ type: 'text' })], 'nope')).toEqual({ [FORM_ERROR_KEY]: ['Must be an object of field values'] });
    expect(errorsFor([field({ type: 'text' })], [])).toEqual({ [FORM_ERROR_KEY]: ['Must be an object of field values'] });
  });
});

describe('buildCaptureSchema', () => {
  it('builds a strict object with one key per field', () => {
    const schema = buildCaptureSchema([field({ key: 'a', type: 'text' }), field({ key: 'b', type: 'number', required: false })]);
    expect(Object.keys(schema.shape)).toEqual(['a', 'b']);
    expect(schema.safeParse({ a: 'x', c: 1 }).success).toBe(false);
  });

  it('matches a pattern against the whole value', () => {
    const f = field({ type: 'text', pattern: 'a|b' });
    expect(accepts(f, 'a')).toBe(true);
    expect(accepts(f, 'ab')).toBe(false);
    expect(accepts(f, 'xa')).toBe(false);
  });

  it(`a patterned value longer than ${PATTERNED_VALUE_MAX_LENGTH} characters is refused before the pattern runs`, () => {
    const f = field({ type: 'longtext', pattern: 'a*' });
    expect(errorsFor([f], { f: 'a'.repeat(PATTERNED_VALUE_MAX_LENGTH + 1) })).toEqual({ f: [`Must be at most ${PATTERNED_VALUE_MAX_LENGTH} characters`] });
  });
});

describe('definition-time checks', () => {
  const problems = (over: Partial<Field> & Pick<Field, 'type'>) => captureFieldProblems(field(over)).map((p) => `${p.path}: ${p.message}`);

  it('a catastrophic pattern such as (a+)+$ is refused at definition time', () => {
    expect(problems({ type: 'text', pattern: '(a+)+$' })).toEqual(['pattern: Pattern could take too long to check: a repeated group contains a repeat']);
    const definition = { fields: [field({ type: 'text', pattern: '(a+)+$' })], steps: [], outputs: [{ id: 'keep', kind: 'persist', config: {} }] };
    const result = WorkTypeDefinition.safeParse(definition);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([['fields.0.pattern', 'Pattern could take too long to check: a repeated group contains a repeat']]);
  });

  it('a pattern longer than 200 characters, or one that does not compile, is refused', () => {
    expect(problems({ type: 'text', pattern: 'a'.repeat(201) })).toEqual(['pattern: Pattern must be at most 200 characters']);
    expect(problems({ type: 'text', pattern: '([a-z]' })).toEqual(['pattern: Pattern is not a valid regular expression']);
  });

  it('a pattern the linear-time matcher does not support is refused', () => {
    expect(problems({ type: 'text', pattern: '\\bword\\b' })).toEqual(['pattern: Pattern must not use a word boundary']);
    expect(problems({ type: 'text', pattern: '\\p{L}' })).toEqual(['pattern: Pattern uses an escape that is not supported: \\p']);
    // Refused on every engine: Node 20's RegExp rejects modifier groups as invalid, later engines accept
    // them and the matcher refuses the group kind (its message is pinned in pattern-matcher.test.ts).
    expect(problems({ type: 'text', pattern: '(?i:a)' })).toHaveLength(1);
    expect(problems({ type: 'text', pattern: 'a{20000}' })).toEqual(['pattern: Pattern is too complex']);
    expect(problems({ type: 'text', pattern: '(?:^)*' })).toEqual(['pattern: Pattern uses a quantified assertion, which is not supported']);
  });

  it('a pattern belongs on text and longtext only, and caps the field at the patterned length', () => {
    expect(problems({ type: 'number', pattern: '\\d+' })).toEqual(['pattern: Only text and longtext fields take a pattern']);
    expect(problems({ type: 'text', pattern: '\\d+', max: PATTERNED_VALUE_MAX_LENGTH + 1 })).toEqual([`max: A field with a pattern takes at most ${PATTERNED_VALUE_MAX_LENGTH} characters`]);
  });

  it('a select needs distinct options, and only a select takes options', () => {
    expect(problems({ type: 'select' })).toEqual(['options: A select field needs at least one option']);
    expect(problems({ type: 'select', options: [] })).toEqual(['options: A select field needs at least one option']);
    expect(problems({ type: 'select', options: ['a', 'a'] })).toEqual(['options: Options must be distinct']);
    expect(problems({ type: 'text', options: ['a'] })).toEqual(['options: Only select fields take options']);
  });

  it('limits: min at most max, whole non-negative lengths, only on text, longtext and number', () => {
    expect(problems({ type: 'number', min: 5, max: 1 })).toEqual(['min: Minimum must not be greater than maximum']);
    expect(problems({ type: 'text', min: -1 })).toEqual(['min: A length must be a whole number, 0 or more']);
    expect(problems({ type: 'text', max: 1.5 })).toEqual(['max: A length must be a whole number, 0 or more']);
    expect(problems({ type: 'date', min: 1 })).toEqual(['min: Only text, longtext and number fields take limits']);
    expect(problems({ type: 'number', min: -5, max: 5 })).toEqual([]);
  });

  it('CaptureField carries the checks, so every definition writer refuses them', () => {
    expect(CaptureField.safeParse(field({ type: 'select', options: [] })).success).toBe(false);
    expect(CaptureField.safeParse(field({ type: 'text', pattern: '[a-z]+' })).success).toBe(true);
  });
});

describe('patternProblem (safe-pattern check)', () => {
  it.each([
    '(a+)+$', '(a*)*', '([a-z]+)*', '(a|a)*', '(a|b)+c', '(?:x+y)+', '((ab)*)+', '(\\d{1,5}){2,}',
  ])('refuses %s', (pattern) => {
    expect(patternProblem(pattern)).toBeDefined();
  });

  it.each([
    ['backreference', '(a)\\1'], ['named backreference', '(?<x>a)\\k<x>'], ['lookahead', 'a(?=b)'], ['negative lookbehind', '(?<!a)b'],
  ])('refuses a %s', (_name, pattern) => {
    expect(patternProblem(pattern)).toMatch(/lookaround|backreference/);
  });

  // Regression (branch review, docs/known-issues/2026-10-21-safe-pattern-bypasses.md): in JavaScript `[]`
  // and `[^]` are whole classes, so a `]` right after them closes the class; and unrepeated alternations
  // multiply, alone and with repeats.
  it.each([
    ['[^](a+)+b]'], ['[](a+)+]'], ['[^]*(a|a)*'], ['(a|a)'.repeat(40)], ['(?:a|a)'.repeat(23) + 'b'], ['(a|a)'.repeat(8) + 'a*a*a*'], ['(a|aa)'.repeat(10) + 'a*a*'],
  ])('refuses %s', (pattern) => {
    expect(patternProblem(pattern)).toMatch(/too long to check/);
  });

  it('refuses more than three variable repeats', () => {
    expect(patternProblem('a*b*c*d*')).toBe('Pattern could take too long to check: more than 3 variable repeats');
  });

  it.each([
    '[A-Z]{3}-\\d{4}', '[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}', '(?:ab)?c', '(foo|bar)', '\\(\\d+\\)', '[(+*]+', 'a{2}', '(?<code>[A-Z]{2})-\\d+', 'x{', '\\\\d',
    '(Mr|Mrs|Ms|Dr)\\.? [A-Z][a-z]+', '[^]]+', '[]a]', '[\\]]+',
  ])('accepts %s', (pattern) => {
    expect(patternProblem(pattern)).toBeUndefined();
  });

  it('the worst patterns it accepts finish quickly on their worst input of the longest length a patterned field takes', () => {
    const worst: [string, string][] = [
      ['a*a*a*b', 'a'.repeat(PATTERNED_VALUE_MAX_LENGTH)],
      ['a*a*a*', `${'a'.repeat(PATTERNED_VALUE_MAX_LENGTH - 1)}b`],
      ['\\w+\\s?\\w+x', 'a'.repeat(PATTERNED_VALUE_MAX_LENGTH)],
      ['(?:a|aa)b?a*a+c', 'a'.repeat(PATTERNED_VALUE_MAX_LENGTH)],
      ['(a|a)'.repeat(22), `${'a'.repeat(22)}b`],
      [`${'(a|a)'.repeat(4)}a*a*`, `${'a'.repeat(PATTERNED_VALUE_MAX_LENGTH - 1)}b`],
      // The second review's bypass: fixed-count repeats after variable ones (2 to 25 s with RegExp).
      ['\\d*\\d*\\d*\\d{60}', `${'1'.repeat(PATTERNED_VALUE_MAX_LENGTH - 1)}x`],
      ['[a-z]*[a-z]*[a-z]*[a-z]{60}', `${'a'.repeat(PATTERNED_VALUE_MAX_LENGTH - 1)}1`],
      ['a*a*a*(?:aa){30}', `${'a'.repeat(PATTERNED_VALUE_MAX_LENGTH - 1)}c`],
      [`${'(a|a)'.repeat(22)}a{200}b`, `${'a'.repeat(222)}c`],
      [`${'(a|a)'.repeat(22)}a{234}`, `${'a'.repeat(PATTERNED_VALUE_MAX_LENGTH - 1)}c`],
    ];
    for (const [pattern, input] of worst) {
      expect(patternProblem(pattern), pattern).toBeUndefined();
      const started = performance.now();
      validateCapture([field({ type: 'text', pattern })], { f: input });
      expect(performance.now() - started, pattern).toBeLessThan(200);
    }
  });

  it(`a definition's patterns together compile to at most ${MAX_DEFINITION_PATTERN_STATES} matcher states`, () => {
    const fields = Array.from({ length: 5 }, (_, i) => field({ key: `f${i}`, type: 'text', pattern: 'a{4000}' }));
    const definition = { fields, steps: [], outputs: [{ id: 'keep', kind: 'persist', config: {} }] };
    expect(WorkTypeDefinition.safeParse(definition).error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([['fields', 'The fields\' patterns are too complex together']]);
    expect(WorkTypeDefinition.safeParse({ ...definition, fields: fields.slice(0, 4) }).success).toBe(true);
    // A stored definition over the budget validates its first patterns and refuses the rest unrun.
    const errors = errorsFor(fields, Object.fromEntries(fields.map((f) => [f.key, 'aaa'])));
    const mismatch = ['Does not match the expected format'];
    expect(errors).toEqual({ f0: mismatch, f1: mismatch, f2: mismatch, f3: mismatch, f4: ['This field cannot be checked: its pattern is unsafe. Ask a team admin to fix the work type.'] });
  });

  // Regression (third branch review): parsing a definition compiled every pattern several times.
  it('a definition as large as the API accepts (100 kB) is checked quickly, however its patterns nest', () => {
    const pattern = `${'('.repeat(95)}a${')'.repeat(95)}{4990}`;
    const fields = Array.from({ length: 408 }, (_, i) => field({ key: `f${i}`, type: 'text', pattern }));
    const definition = { fields, steps: [], outputs: [{ id: 'keep', kind: 'persist', config: {} }] };
    expect(JSON.stringify({ definition }).length).toBeGreaterThan(100_000);
    let started = performance.now();
    expect(WorkTypeDefinition.safeParse(definition).error?.issues.map((i) => i.message)).toEqual(['The fields\' patterns are too complex together']);
    expect(performance.now() - started).toBeLessThan(500);
    // Stored anyway (before the check), validating an item compiles only what the budget allows.
    started = performance.now();
    validateCapture(fields, {});
    expect(performance.now() - started).toBeLessThan(500);
  });

  // Regression (fourth branch review): a class counted as one state but tested each member, so 77
  // fields of `.*[\s x 94 \d]{256}` (within the state budget) took 2.1 s to validate one item.
  it.each([
    ['repeated class escapes', `.*[${'\\s'.repeat(94)}\\d]{256}`],
    ['many separate ranges', `.*[${Array.from({ length: 180 }, (_, i) => String.fromCharCode(0x100 + i * 2)).join('')}0-9]{8}`],
  ])('an item of patterned fields with long classes validates quickly (%s)', (_name, pattern) => {
    expect(pattern.length).toBeLessThanOrEqual(200);
    const fields = Array.from({ length: 77 }, (_, i) => field({ key: `f${i}`, type: 'text', pattern }));
    expect(WorkTypeDefinition.safeParse({ fields, steps: [], outputs: [{ id: 'keep', kind: 'persist', config: {} }] }).success).toBe(true);
    const started = performance.now();
    expect(validateCapture(fields, Object.fromEntries(fields.map((f) => [f.key, '1'.repeat(256)]))).ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(budget(600));
  });

  it('a stored pattern that fails the check is never run: the field is refused instead', () => {
    // Definitions are not re-parsed when read (docs/known-issues/2026-10-21-work-type-version-delete-and-definition-reparse.md),
    // so one written before a check existed reaches validateCapture as stored.
    const started = performance.now();
    const errors = errorsFor([field({ type: 'text', pattern: '(a+)+$' })], { f: `${'a'.repeat(40)}!` });
    expect(performance.now() - started).toBeLessThan(100);
    expect(errors).toEqual({ f: ['This field cannot be checked: its pattern is unsafe. Ask a team admin to fix the work type.'] });
  });
});

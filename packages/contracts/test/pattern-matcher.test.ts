import { describe, expect, it } from 'vitest';
import { analysePattern, compilePattern, MAX_STATES } from '../src/pattern-matcher.js';
import { budget } from './time-budget.js';

const matcher = (pattern: string) => {
  const compiled = compilePattern(pattern);
  if (!compiled.ok) throw new Error(`refused ${pattern}: ${compiled.problem}`);
  return compiled;
};
const problem = (pattern: string) => {
  const compiled = compilePattern(pattern);
  return compiled.ok ? undefined : compiled.problem;
};

// Differential test: on every supported pattern the linear-time matcher agrees with V8's RegExp, used
// the way capture.ts used it before (no flags, the whole value must match).
const corpus: [string, string[]][] = [
  ['abc', ['abc', 'ab', 'abcd', '', 'xabc']],
  ['a|b|', ['a', 'b', '', 'ab']],
  ['(foo|bar)baz', ['foobaz', 'barbaz', 'baz', 'foobarbaz']],
  ['(?:ab)+c?', ['ab', 'ababc', 'abc', 'c', '', 'aba']],
  ['(?<code>[A-Z]{2})-\\d+', ['AB-1', 'AB-123', 'A-1', 'ab-1', 'AB-']],
  ['[A-Z]{3}-\\d{4}', ['ABC-1234', 'ABC-123', 'ABC-12345', 'AbC-1234']],
  ['[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}', ['a.b@c.de', 'a@b.c', 'a@b.cde', '@b.cd', 'a@b.c-d']],
  ['a{2,4}', ['a', 'aa', 'aaa', 'aaaa', 'aaaaa']],
  ['a{0}b', ['b', 'ab']],
  ['a{3,}?', ['aa', 'aaa', 'aaaaaa']],
  ['x*?y+?z??', ['y', 'xxyyz', 'z', 'xyzz']],
  ['.+', ['a', '\n', 'a\rb', 'a ', ' ', '']],
  ['[^]*', ['', 'anything\n at all']],
  ['[]', ['', 'a']],
  ['a[]?b', ['ab', 'a']],
  ['[^abc]+', ['xyz', 'xaz', '\n']],
  ['[\\d\\s]+', ['1 2', '1\t2 3　', 'a']],
  ['[\\D]', ['a', '1']],
  ['[\\w-]+', ['ab_c-d9', 'a b']],
  ['[a\\-z]+', ['a-z', 'b']],
  ['[-a]+|[a-]+', ['-a-', 'b']],
  ['[\\]]+', [']]', '[']],
  ['[\\b]', ['\b', 'b']],
  ['\\W\\S\\D', ['!a!', 'a!a', '! !']],
  ['\\s+', [' \t\n\v\f\r        　﻿', '​']],
  ['\\t\\n\\r\\v\\f\\0', ['\t\n\r\v\f\0', 'tnrvf0']],
  ['\\x41\\u0042\\cJ', ['AB\n', 'AB\r']],
  ['\\.\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|\\\\\\/\\^\\$\\-', ['.*+?()[]{}|\\/^$-']],
  ['x{', ['x{', 'x']],
  ['x{1', ['x{1', 'x']],
  ['a}b]', ['a}b]']],
  ['^ab$', ['ab', 'a']],
  ['a^b|c', ['c', 'ab', 'a^b']],
  ['(a|ab)(c|bcd)(d*)', ['abcd', 'abcdd', 'ac', 'abd']],
  ['(a*)*b', ['b', 'aab', 'aa']],
  ['(a?)+', ['', 'a', 'aa']],
  ['((a)|b)+', ['abab', 'abc']],
  ['[\\x41-\\x43]+', ['ABC', 'ABD']],
  ['[\\u00e0-\\u00ff]', ['é', 'e']],
  ['é+', ['éé', 'e']],
  ['😀', ['😀', '\ud83d']],
];

describe('compilePattern: agrees with RegExp on supported patterns', () => {
  it.each(corpus)('%s', (pattern, inputs) => {
    const compiled = matcher(pattern);
    const native = new RegExp(`^(?:${pattern})$`);
    for (const input of inputs) expect(compiled.match(input), JSON.stringify(input)).toBe(native.test(input));
  });
});

describe('analysePattern', () => {
  it.each(corpus.map(([pattern]) => pattern))('counts the states %s compiles to, without building them', (pattern) => {
    expect(analysePattern(pattern)).toEqual({ ok: true, states: matcher(pattern).states });
  });

  it('refuses what compilePattern refuses, with the same problem', () => {
    for (const pattern of ['\\b', 'a{100000}', '(a', '(?:a{1000}){20}']) expect(analysePattern(pattern)).toEqual(compilePattern(pattern));
  });

  // Regression (third branch review): nested groups cost compile work without adding states, so a
  // pattern under the state cap took 26 ms to compile, and a definition of 408 such fields 14 s to parse.
  it('compiles a deeply nested pattern without walking the nesting once per copy', () => {
    const pattern = `${'('.repeat(95)}a${')'.repeat(95)}{4990}`;
    const started = performance.now();
    expect(analysePattern(pattern)).toEqual({ ok: true, states: 4991 });
    expect(compilePattern(pattern).ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('compilePattern: refuses what it does not support', () => {
  it.each([
    ['\\b', 'word boundary'], ['a\\B', 'word boundary'], ['(a)\\1', 'backreference'], ['\\01', 'octal'], ['(?<x>a)\\k<x>', 'backreference'],
    ['a(?=b)', 'lookaround'], ['a(?!b)', 'lookaround'], ['(?<=a)b', 'lookaround'], ['(?<!a)b', 'lookaround'], ['(?i:a)', 'group'],
    ['\\p{L}', 'escape'], ['\\a', 'escape'], ['\\x4', 'escape'], ['\\u12', 'escape'], ['\\c1', 'escape'], ['[\\c1]', 'escape'], ['[\\d-z]', 'range'],
    ['a**', 'syntax'], ['(a', 'syntax'], ['a)', 'syntax'], ['*a', 'syntax'], ['[a', 'syntax'], ['a\\', 'syntax'], ['a{2,1}', 'syntax'], ['[z-a]', 'syntax'], ['^*', 'syntax'],
  ])('%s (%s)', (pattern) => {
    expect(problem(pattern)).toBeDefined();
  });

  it('names the group kind it refuses, without asking RegExp (whose answer depends on the Node version)', () => {
    expect(problem('(?i:a)')).toBe('Pattern uses a group kind that is not supported');
  });

  // GWP#21: RegExp accepts a repeated assertion, so "not a valid regular expression" was wrong for these.
  it('refuses a quantified assertion that RegExp accepts, saying so', () => {
    for (const pattern of ['(?:^)*', '($)?', '(?:^){2}', 'a(?:$)+']) {
      expect(() => new RegExp(pattern)).not.toThrow();
      expect(problem(pattern)).toBe('Pattern uses a quantified assertion, which is not supported');
    }
  });

  it(`refuses a pattern that expands past ${MAX_STATES} states`, () => {
    expect(problem('(?:a{1000}){20}')).toBe('Pattern is too complex');
    expect(problem('a{100000}')).toBe('Pattern is too complex');
    expect(problem(`(?:${'a|'.repeat(60)}a){200}`)).toBe('Pattern is too complex');
  });
});

const bigClass = `[${Array.from({ length: 180 }, (_, i) => String.fromCharCode(0x4e00 + i * 2)).join('')}]`;

describe('compilePattern: linear time', () => {
  // Patterns that hang a backtracking engine (the branch reviews found the last six passing the
  // definition-time check of the time); the matcher's work is bounded by value length x states.
  it.each([
    ['(a+)+$', `${'a'.repeat(255)}!`],
    ['(a|a)*', `${'a'.repeat(255)}!`],
    ['(a|aa)+c', 'a'.repeat(256)],
    ['[^](a+)+b]', `x${'a'.repeat(255)}`],
    ['\\d*\\d*\\d*\\d{60}', `${'1'.repeat(255)}x`],
    ['[a-z]*[a-z]*[a-z]*[a-z]{60}', `${'a'.repeat(255)}1`],
    ['a*a*a*(?:aa){30}', `${'a'.repeat(255)}c`],
    [`${'(a|a)'.repeat(22)}a{200}b`, `${'a'.repeat(222)}c`],
    [`${'(a|a)'.repeat(22)}a{234}`, `${'a'.repeat(255)}c`],
    [`${'(a|a)'.repeat(8)}a*a*a*`, `${'a'.repeat(255)}b`],
  ])('%s', (pattern, input) => {
    const compiled = matcher(pattern);
    const started = performance.now();
    expect(compiled.match(input)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });

  // The most states a pattern may have, every one live at every position, one with a long class tested
  // at each: about 25 ms on a developer machine, several times that under coverage instrumentation.
  it.each([
    ['(?:a?){2499}', `${'a'.repeat(255)}!`],
    [`(?:${bigClass}?){2400}`, `${'\u4e02'.repeat(255)}!`],
  ])('worst case: %s', (pattern, input) => {
    const compiled = matcher(pattern);
    expect(compiled.states).toBeGreaterThan(MAX_STATES * 0.95);
    const started = performance.now();
    expect(compiled.match(input)).toBe(false);
    expect(performance.now() - started).toBeLessThan(budget(500));
  });
});

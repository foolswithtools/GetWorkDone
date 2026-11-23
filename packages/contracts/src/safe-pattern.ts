// The safe-regex check for capture field patterns (GWP#4): definition-time policy. A definition is
// refused when its pattern has a shape that backtracks catastrophically in a regular-expression engine
// like V8's (`(a+)+$`), so no such pattern is ever stored, even though the API does not run patterns
// with RegExp: pattern-matcher.ts matches them in linear time, and that, not this check, bounds how long
// a match takes (static estimates of backtracking cost were bypassed twice in review,
// docs/known-issues/2026-10-21-safe-pattern-bypasses.md). It refuses:
//   - a repeat applied to a group that holds a repeat or an alternation (`(a+)+`, `(a|a)*`);
//   - more than MAX_VARIABLE_REPEATS variable repeats (`*`, `+`, `?`, `{n,}`, `{n,m}` with m > n);
//   - more than MAX_PATHS estimated ways to match: the product of every group's alternative count and
//     every variable repeat's range (an unbounded one ranges over PATTERNED_VALUE_MAX_LENGTH + 1
//     lengths), divided by k! for k repeats, which refuses chains such as `(a|a)(a|a)...`;
//   - backreferences and lookarounds.
// It reads the pattern as JavaScript source without flags, where `[]` (nothing) and `[^]` (anything) are
// complete classes. No dependency: the same code runs in the browser and the API.

/** The longest value a field with a pattern takes; it bounds how long the pattern can run. */
export const PATTERNED_VALUE_MAX_LENGTH = 256;
export const MAX_VARIABLE_REPEATS = 3;
export const MAX_PATHS = 2 ** 22;

interface Group { repeats: boolean; alternates: boolean; alternatives: number }
type Atom = Group | 'simple' | undefined;

const TOO_SLOW = 'Pattern could take too long to check';
const newGroup = (): Group => ({ repeats: false, alternates: false, alternatives: 1 });

interface Quantifier { length: number; repeats: boolean; varies: boolean; range: number }

/** A quantifier at `i`: its length, whether it repeats (upper bound > 1), varies (upper > lower), and how many counts it allows. */
function quantifierAt(pattern: string, i: number): Quantifier | undefined {
  const unbounded = PATTERNED_VALUE_MAX_LENGTH + 1;
  const c = pattern[i];
  if (c === '*' || c === '+') return { length: 1, repeats: true, varies: true, range: unbounded };
  if (c === '?') return { length: 1, repeats: false, varies: true, range: 2 };
  if (c !== '{') return undefined;
  const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
  if (!match) return undefined; // a literal `{`
  const low = Number(match[1]);
  const high = match[2] === undefined ? low : match[3] === '' ? Infinity : Number(match[3]);
  return { length: match[0].length, repeats: high > 1, varies: high > low, range: Math.min(high - low + 1, unbounded) };
}

/** Why `pattern` is unsafe to run on user input, or undefined when it passes the check. */
export function patternProblem(pattern: string): string | undefined {
  const root = newGroup();
  const stack: Group[] = [];
  const top = () => stack[stack.length - 1] ?? root;
  let last: Atom;
  let variable = 0;
  let paths = 1;
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    const current = top();
    if (c === '\\') {
      const next = pattern[i + 1];
      if (next !== undefined && /[1-9]/.test(next)) return 'Pattern must not use a backreference';
      if (next === 'k' && pattern[i + 2] === '<') return 'Pattern must not use a backreference';
      last = 'simple';
      i += 2;
      continue;
    }
    if (c === '[') {
      // A character class is one atom; skip to its closing bracket. In JavaScript a `]` is never
      // literal at the start of a class: `[]` and `[^]` are complete.
      let j = i + 1;
      if (pattern[j] === '^') j++;
      while (j < pattern.length && pattern[j] !== ']') j += pattern[j] === '\\' ? 2 : 1;
      last = 'simple';
      i = j + 1;
      continue;
    }
    if (c === '(') {
      if (/^\(\?(=|!|<=|<!)/.test(pattern.slice(i))) return 'Pattern must not use a lookaround';
      stack.push(newGroup());
      last = undefined;
      // Skip the group's prefix: `(?:` or a name, `(?<name>`.
      const named = /^\(\?<[A-Za-z_$][\w$]*>/.exec(pattern.slice(i));
      i += named ? named[0].length : pattern.startsWith('(?:', i) ? 3 : 1;
      continue;
    }
    if (c === ')') {
      // An unmatched `)` does not compile; capture.ts refuses the pattern for that.
      const group = stack.pop() ?? root;
      // What the group holds counts for the group around it, repeated or not.
      const parent = top();
      parent.repeats ||= group.repeats;
      parent.alternates ||= group.alternates;
      if (group !== root) paths *= group.alternatives;
      last = group;
      i += 1;
      continue;
    }
    if (c === '|') {
      current.alternates = true;
      current.alternatives += 1;
      last = undefined;
      i += 1;
      continue;
    }
    const quantifier = quantifierAt(pattern, i);
    if (quantifier) {
      if (quantifier.repeats && typeof last === 'object') {
        if (last.repeats) return `${TOO_SLOW}: a repeated group contains a repeat`;
        if (last.alternates) return `${TOO_SLOW}: a repeated group contains an alternation`;
      }
      if (quantifier.varies) {
        variable += 1;
        paths *= quantifier.range;
      }
      current.repeats = true;
      i += quantifier.length;
      if (pattern[i] === '?') i += 1; // lazy
      last = undefined;
      continue;
    }
    last = 'simple';
    i += 1;
  }
  // Groups left open do not compile; count their alternatives anyway, and the top level's.
  for (const group of [...stack, root]) paths *= group.alternatives;
  if (variable > MAX_VARIABLE_REPEATS) return `${TOO_SLOW}: more than ${MAX_VARIABLE_REPEATS} variable repeats`;
  // k repeats over one value split it in at most range^k / k! ways.
  for (let k = 2; k <= variable; k++) paths /= k;
  if (paths > MAX_PATHS) return `${TOO_SLOW}: too many alternatives and repeats`;
  return undefined;
}

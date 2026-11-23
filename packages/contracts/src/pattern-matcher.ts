// A linear-time matcher for capture field patterns (GWP#4, docs/capture.md). A field's `pattern` runs in
// the API on every submitted item. V8's RegExp backtracks, and estimating its cost from the pattern was
// bypassed twice in review (docs/known-issues/2026-10-21-safe-pattern-bypasses.md), so patterns are not
// run with RegExp at all: they are compiled to a Thompson NFA and simulated with state sets, whose work
// is at most (value length + 1) x MAX_STATES whatever the pattern. The same code runs in the browser and
// the API, so both sides match identically.
//
// It reads JavaScript regular expression syntax without flags (UTF-16 code units, as RegExp without
// `u`) and supports: literals; `.`; `\d \D \w \W \s \S \t \n \r \v \f \0 \xHH \uHHHH \cX` and escaped
// punctuation; classes with ranges, negation and those escapes (`[]` matches nothing, `[^]` anything);
// `(...)`, `(?:...)` and `(?<name>...)` groups; `|`; `* + ? {n} {n,} {n,m}` (a lazy `?` after them
// changes nothing for a whole-value match); `^` and `$`; and, as RegExp does, `{`, `}` and `]` as
// literals where they cannot be anything else. Anything else is refused: word boundaries,
// backreferences, lookarounds, other group kinds, legacy octal and other escapes RegExp reads loosely.
// Whether a pattern is a valid regular expression at all is still asked of RegExp (capture.ts).

/** The most NFA states a pattern may compile to; `{n,m}` copies its operand, so this bounds expansion. */
export const MAX_STATES = 5_000;

type Test = (code: number) => boolean;

type Node =
  | { kind: 'char'; test: Test }
  | { kind: 'seq'; items: Node[] }
  | { kind: 'alt'; options: Node[] }
  | { kind: 'repeat'; item: Node; min: number; max: number }
  | { kind: 'assert'; at: 'start' | 'end' };

class Refused extends Error {}

// Character sets are sorted, merged, inclusive code-unit ranges; a set is tested by binary search, so a
// step costs O(log ranges) however a class is written (a class of 94 `\s` is the same set as `[\s]`).
type Ranges = [number, number][];
const MAX_UNIT = 0xffff;

function normalise(ranges: Ranges): Ranges {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Ranges = [];
  for (const [low, high] of sorted) {
    const last = merged[merged.length - 1];
    if (last && low <= last[1] + 1) last[1] = Math.max(last[1], high);
    else merged.push([low, high]);
  }
  return merged;
}

function complement(ranges: Ranges): Ranges {
  const result: Ranges = [];
  let next = 0;
  for (const [low, high] of normalise(ranges)) {
    if (low > next) result.push([next, low - 1]);
    next = high + 1;
  }
  if (next <= MAX_UNIT) result.push([next, MAX_UNIT]);
  return result;
}

function setTest(ranges: Ranges): Test {
  const merged = normalise(ranges);
  const lows = Int32Array.from(merged, (r) => r[0]);
  const highs = Int32Array.from(merged, (r) => r[1]);
  return (c) => {
    if (!(c >= 0)) return false; // NaN: charCodeAt past the end
    let lo = 0;
    let hi = lows.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (c < (lows[mid] as number)) hi = mid - 1;
      else if (c > (highs[mid] as number)) lo = mid + 1;
      else return true;
    }
    return false;
  };
}

const DIGIT: Ranges = [[48, 57]];
const WORD: Ranges = [[48, 57], [65, 90], [95, 95], [97, 122]];
const SPACE: Ranges = [[9, 13], [32, 32], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff]];
const LINE_TERMINATORS: Ranges = [[10, 10], [13, 13], [0x2028, 0x2029]];
const CLASS_ESCAPES: Record<string, Ranges> = { d: DIGIT, D: complement(DIGIT), w: WORD, W: complement(WORD), s: SPACE, S: complement(SPACE) };
const isDigit = setTest(DIGIT);
const CONTROL_ESCAPES: Record<string, number> = { t: 9, n: 10, v: 11, f: 12, r: 13 };
const QUANTIFIER = /^\{(\d+)(,(\d*))?\}/;

class Parser {
  private i = 0;
  constructor(private readonly src: string) {}

  parse(): Node {
    const node = this.alternation();
    if (this.i < this.src.length) throw new Refused('Pattern is not a valid regular expression');
    return node;
  }

  private peek(offset = 0): string | undefined {
    return this.src[this.i + offset];
  }

  private alternation(): Node {
    const options = [this.sequence()];
    while (this.peek() === '|') {
      this.i += 1;
      options.push(this.sequence());
    }
    return options.length === 1 ? options[0] as Node : { kind: 'alt', options };
  }

  private sequence(): Node {
    const items: Node[] = [];
    for (let c = this.peek(); c !== undefined && c !== '|' && c !== ')'; c = this.peek()) {
      const atom = this.atom();
      items.push(this.quantified(atom));
    }
    // A group's single item is the item itself, so nesting costs nothing to compile.
    return items.length === 1 ? items[0] as Node : { kind: 'seq', items };
  }

  private quantified(atom: Node): Node {
    const c = this.peek();
    let min: number;
    let max: number;
    if (c === '*') [min, max] = [0, Infinity];
    else if (c === '+') [min, max] = [1, Infinity];
    else if (c === '?') [min, max] = [0, 1];
    else {
      const match = c === '{' ? QUANTIFIER.exec(this.src.slice(this.i)) : null;
      if (!match) return atom;
      min = Number(match[1]);
      max = match[2] === undefined ? min : match[3] === '' ? Infinity : Number(match[3]);
      if (max < min) throw new Refused('Pattern is not a valid regular expression');
      this.i += match[0].length - 1;
    }
    this.i += 1;
    if (this.peek() === '?') this.i += 1; // lazy: the same set of whole-value matches
    // `(?:^)*` and `($)?` are valid RegExp, unlike a bare `^*` (which checkPattern in capture.ts refuses first).
    if (atom.kind === 'assert') throw new Refused('Pattern uses a quantified assertion, which is not supported');
    const next = this.peek();
    if (next === '*' || next === '+' || next === '?' || (next === '{' && QUANTIFIER.test(this.src.slice(this.i)))) throw new Refused('Pattern is not a valid regular expression');
    return { kind: 'repeat', item: atom, min, max };
  }

  private atom(): Node {
    const c = this.peek() as string;
    if (c === '*' || c === '+' || c === '?' || (c === '{' && QUANTIFIER.test(this.src.slice(this.i)))) throw new Refused('Pattern is not a valid regular expression');
    this.i += 1;
    if (c === '^') return { kind: 'assert', at: 'start' };
    if (c === '$') return { kind: 'assert', at: 'end' };
    if (c === '.') return { kind: 'char', test: setTest(complement(LINE_TERMINATORS)) };
    if (c === '[') return this.characterClass();
    if (c === '\\') return { kind: 'char', test: setTest(this.escape(false).ranges) };
    if (c === '(') return this.group();
    const code = c.charCodeAt(0);
    return { kind: 'char', test: (x) => x === code };
  }

  private group(): Node {
    if (this.src.startsWith('?=', this.i) || this.src.startsWith('?!', this.i) || this.src.startsWith('?<=', this.i) || this.src.startsWith('?<!', this.i)) {
      throw new Refused('Pattern must not use a lookaround');
    }
    if (this.src.startsWith('?:', this.i)) this.i += 2;
    else if (this.peek() === '?') {
      const named = /^\?<[A-Za-z_$][\w$]*>/.exec(this.src.slice(this.i));
      if (!named) throw new Refused('Pattern uses a group kind that is not supported');
      this.i += named[0].length;
    }
    const inner = this.alternation();
    if (this.peek() !== ')') throw new Refused('Pattern is not a valid regular expression');
    this.i += 1;
    return inner;
  }

  /**
   * An escape after `\`: a class escape (`\d`) as its set, anything else as the one code unit it stands
   * for. In a class, `\b` is backspace.
   */
  private escape(inClass: boolean): { ranges: Ranges; code?: number } {
    const c = this.peek();
    if (c === undefined) throw new Refused('Pattern is not a valid regular expression');
    this.i += 1;
    const classEscape = CLASS_ESCAPES[c];
    if (classEscape) return { ranges: classEscape };
    const unit = (code: number): { ranges: Ranges; code: number } => ({ code, ranges: [[code, code]] });
    const control = CONTROL_ESCAPES[c];
    if (control !== undefined) return unit(control);
    if (c === 'b' && inClass) return unit(8);
    if (c === 'b' || c === 'B') throw new Refused('Pattern must not use a word boundary');
    if (c === '0') {
      if (isDigit(this.src.charCodeAt(this.i))) throw new Refused('Pattern must not use an octal escape');
      return unit(0);
    }
    if (/[1-9]/.test(c) || c === 'k') throw new Refused('Pattern must not use a backreference');
    if (c === 'x' || c === 'u') {
      const length = c === 'x' ? 2 : 4;
      const digits = this.src.slice(this.i, this.i + length);
      if (digits.length !== length || !/^[0-9a-fA-F]+$/.test(digits)) throw new Refused(`Pattern uses an escape that is not supported: \\${c}`);
      this.i += length;
      return unit(parseInt(digits, 16));
    }
    if (c === 'c') {
      const letter = this.peek();
      if (letter === undefined || !/[A-Za-z]/.test(letter)) throw new Refused('Pattern uses an escape that is not supported: \\c');
      this.i += 1;
      return unit(letter.charCodeAt(0) % 32);
    }
    if (/[A-Za-z0-9_]/.test(c)) throw new Refused(`Pattern uses an escape that is not supported: \\${c}`);
    return unit(c.charCodeAt(0));
  }

  private characterClass(): Node {
    const negated = this.peek() === '^';
    if (negated) this.i += 1;
    const ranges: Ranges = [];
    // One class member: a single code unit (which can start or end a range) or a class escape such as \d.
    const member = (): { ranges: Ranges; code?: number } => {
      const c = this.peek();
      if (c === undefined) throw new Refused('Pattern is not a valid regular expression');
      this.i += 1;
      if (c !== '\\') {
        const code = c.charCodeAt(0);
        return { code, ranges: [[code, code]] };
      }
      return this.escape(true);
    };
    while (this.peek() !== ']') {
      const low = member();
      if (this.peek() === '-' && this.peek(1) !== ']' && this.peek(1) !== undefined) {
        this.i += 1;
        const high = member();
        if (low.code === undefined || high.code === undefined) throw new Refused('Pattern uses a class range with \\d, \\w or \\s, which is not supported');
        if (low.code > high.code) throw new Refused('Pattern is not a valid regular expression');
        ranges.push([low.code, high.code]);
      } else {
        ranges.push(...low.ranges);
      }
    }
    this.i += 1;
    return { kind: 'char', test: setTest(negated ? complement(ranges) : ranges) };
  }
}

// The NFA: `char` states consume one code unit; `split` and `assert` states move without consuming.
type State =
  | { type: 'char'; test: Test; out: number }
  | { type: 'split'; out: number; out2: number }
  | { type: 'assert'; at: 'start' | 'end'; out: number }
  | { type: 'match' };

/** A fragment under construction: its start state and the dangling exits to patch to what follows. */
interface Fragment { start: number; exits: { state: number; field: 'out' | 'out2' }[] }

/** The states compile(node) adds, computed from the tree: linear in its size, whatever the counts. */
function stateCount(node: Node): number {
  switch (node.kind) {
    case 'char':
    case 'assert':
      return 1;
    case 'seq':
      return node.items.length === 0 ? 1 : node.items.reduce((total, item) => total + stateCount(item), 0);
    case 'alt':
      return node.options.reduce((total, option) => total + stateCount(option), node.options.length - 1);
    case 'repeat': {
      if (node.max === 0) return 1;
      const item = stateCount(node.item);
      return node.min * item + (node.max === Infinity ? item + 1 : (node.max - node.min) * (item + 1));
    }
  }
}

class Compiler {
  readonly states: State[] = [];

  private add(state: State): number {
    if (this.states.length >= MAX_STATES) throw new Refused('Pattern is too complex');
    this.states.push(state);
    return this.states.length - 1;
  }

  private patch(fragment: Fragment, to: number): void {
    for (const { state, field } of fragment.exits) (this.states[state] as Record<string, unknown>)[field] = to;
  }

  /** An epsilon state with one exit, used for empty sequences. */
  private empty(): Fragment {
    const s = this.add({ type: 'split', out: -1, out2: -1 });
    // Both exits continue to the same place.
    return { start: s, exits: [{ state: s, field: 'out' }, { state: s, field: 'out2' }] };
  }

  compile(node: Node): Fragment {
    switch (node.kind) {
      case 'char': {
        const s = this.add({ type: 'char', test: node.test, out: -1 });
        return { start: s, exits: [{ state: s, field: 'out' }] };
      }
      case 'assert': {
        const s = this.add({ type: 'assert', at: node.at, out: -1 });
        return { start: s, exits: [{ state: s, field: 'out' }] };
      }
      case 'seq': {
        if (node.items.length === 0) return this.empty();
        const parts = node.items.map((item) => this.compile(item));
        for (let k = 0; k < parts.length - 1; k++) this.patch(parts[k] as Fragment, (parts[k + 1] as Fragment).start);
        return { start: (parts[0] as Fragment).start, exits: (parts[parts.length - 1] as Fragment).exits };
      }
      case 'alt': {
        const parts = node.options.map((option) => this.compile(option));
        // A chain of splits: option 1, else option 2, else ...
        let start = (parts[parts.length - 1] as Fragment).start;
        for (let k = parts.length - 2; k >= 0; k--) start = this.add({ type: 'split', out: (parts[k] as Fragment).start, out2: start });
        return { start, exits: parts.flatMap((p) => p.exits) };
      }
      case 'repeat': {
        const parts: Fragment[] = [];
        for (let k = 0; k < node.min; k++) parts.push(this.compile(node.item));
        if (node.max === Infinity) {
          const body = this.compile(node.item);
          const loop = this.add({ type: 'split', out: body.start, out2: -1 });
          this.patch(body, loop);
          parts.push({ start: loop, exits: [{ state: loop, field: 'out2' }] });
        } else {
          // max - min optional copies, chained: skipping one skips the rest.
          let first: number | undefined;
          let previous: Fragment['exits'] = [];
          const skips: Fragment['exits'] = [];
          for (let k = node.min; k < node.max; k++) {
            const body = this.compile(node.item);
            const split = this.add({ type: 'split', out: body.start, out2: -1 });
            if (first === undefined) first = split;
            else this.patch({ start: split, exits: previous }, split);
            skips.push({ state: split, field: 'out2' });
            previous = body.exits;
          }
          if (first !== undefined) parts.push({ start: first, exits: [...previous, ...skips] });
        }
        if (parts.length === 0) return this.empty();
        for (let k = 0; k < parts.length - 1; k++) this.patch(parts[k] as Fragment, (parts[k + 1] as Fragment).start);
        return { start: (parts[0] as Fragment).start, exits: (parts[parts.length - 1] as Fragment).exits };
      }
    }
  }
}

export interface CompiledPattern {
  ok: true;
  /** The NFA's state count: a match costs at most (value length + 1) x states steps. */
  states: number;
  /** Whether the whole value matches, as `^(?:pattern)$` would. */
  match(value: string): boolean;
}

type Analysed = { ok: true; node: Node; states: number } | { ok: false; problem: string };

function analyse(pattern: string): Analysed {
  try {
    const node = new Parser(pattern).parse();
    const states = stateCount(node);
    // The accepting state is the one more.
    return states > MAX_STATES ? { ok: false, problem: 'Pattern is too complex' } : { ok: true, node, states: states + 1 };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, problem: error.message };
    throw error;
  }
}

/**
 * Whether compilePattern would accept a pattern, and its state count, without building the NFA: linear
 * in the pattern's length, so definition-time checks stay cheap however large the counts in it.
 */
export function analysePattern(pattern: string): { ok: true; states: number } | { ok: false; problem: string } {
  const analysed = analyse(pattern);
  return analysed.ok ? { ok: true, states: analysed.states } : analysed;
}

/** Compile a pattern to a linear-time whole-value matcher, or say why it is refused. */
export function compilePattern(pattern: string): CompiledPattern | { ok: false; problem: string } {
  const analysed = analyse(pattern);
  if (!analysed.ok) return analysed;
  let states: State[];
  let start: number;
  try {
    const compiler = new Compiler();
    const fragment = compiler.compile(analysed.node);
    const accept = compiler.states.length;
    compiler.states.push({ type: 'match' });
    for (const { state, field } of fragment.exits) (compiler.states[state] as Record<string, unknown>)[field] = accept;
    states = compiler.states;
    start = fragment.start;
  } catch (error) {
    if (error instanceof Refused) return { ok: false, problem: error.message };
    throw error;
  }
  return {
    ok: true,
    states: states.length,
    match(value: string): boolean {
      const count = states.length;
      // seen[s] is the last position s was added at; each position visits a state at most once.
      const seen = new Int32Array(count).fill(-1);
      const stack = new Int32Array(count * 2 + 2);
      let current = new Int32Array(count);
      let next = new Int32Array(count);
      // Follow every move that consumes nothing from `from` at `pos`, collecting char and match states.
      const close = (from: number, pos: number, into: Int32Array, length: number): number => {
        let top = 0;
        stack[top++] = from;
        while (top > 0) {
          const s = stack[--top] as number;
          if (seen[s] === pos) continue;
          seen[s] = pos;
          const state = states[s] as State;
          if (state.type === 'split') {
            stack[top++] = state.out2;
            stack[top++] = state.out;
          } else if (state.type === 'assert') {
            if (state.at === 'start' ? pos === 0 : pos === value.length) stack[top++] = state.out;
          } else {
            into[length++] = s;
          }
        }
        return length;
      };
      let size = close(start, 0, current, 0);
      for (let pos = 0; pos < value.length && size > 0; pos++) {
        const code = value.charCodeAt(pos);
        let nextSize = 0;
        for (let k = 0; k < size; k++) {
          const state = states[current[k] as number] as State;
          if (state.type === 'char' && state.test(code)) nextSize = close(state.out, pos + 1, next, nextSize);
        }
        [current, next] = [next, current];
        size = nextSize;
      }
      for (let k = 0; k < size; k++) if ((states[current[k] as number] as State).type === 'match') return true;
      return false;
    },
  };
}

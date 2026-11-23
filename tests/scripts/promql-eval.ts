// A small PromQL evaluator for tests (GWP#53): enough of the language to run the burn-rate rules'
// expressions (observability/slo/definitions.ts) over recorded counter samples, so a test can show what a
// rule returns at a given traffic shape. No Prometheus or promtool is a dev dependency.
//
// Supported: number literals; series selectors with =, !=, =~ and !~ matchers and a range; rate(),
// increase(), min_over_time() and absent_over_time() over a range; sum() and max() with an optional `by (...)`; the binary operators + - * / and the
// comparisons == != > < >= <= (filtering, or with `bool`) between scalars and vectors, with one-to-one
// matching on the full label set; and `and`. The signal rules (observability/signals/definitions.ts) run
// through it too. Anything else throws, so a rule that grows past this subset
// fails its test rather than being evaluated wrongly.
//
// Simplified on purpose: increase() is the last sample minus the first inside the range, without
// Prometheus's extrapolation to the range's edges, and counters never reset. The tests record counters as
// steps that the whole window covers, where both readings agree.

export type Labels = Record<string, string>;

export interface Series {
  /** Includes __name__. */
  labels: Labels;
  /** [unix seconds, value], ascending. */
  points: [number, number][];
}

interface Sample {
  labels: Labels;
  value: number;
}

type Value = { kind: 'scalar'; value: number } | { kind: 'vector'; samples: Sample[] };

type Token = { type: 'num'; value: number } | { type: 'ident'; value: string } | { type: 'str'; value: string } | { type: 'op'; value: string } | { type: 'dur'; value: number };

const DURATION_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '[') {
      const end = input.indexOf(']', i);
      const m = /^(\d+)([smhd])$/.exec(input.slice(i + 1, end).trim());
      if (end < 0 || !m) throw new Error(`promql-eval: bad range at ${i}`);
      tokens.push({ type: 'dur', value: Number(m[1]) * DURATION_UNITS[m[2]!]! });
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (input[j] !== '"') {
        if (j >= input.length) throw new Error('promql-eval: unterminated string');
        if (input[j] === '\\') j++;
        value += input[j];
        j++;
      }
      tokens.push({ type: 'str', value });
      i = j + 1;
      continue;
    }
    const num = /^\d+(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(input.slice(i));
    if (num) {
      tokens.push({ type: 'num', value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const ident = /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(input.slice(i));
    if (ident) {
      tokens.push({ type: 'ident', value: ident[0] });
      i += ident[0].length;
      continue;
    }
    const op = /^(?:>=|<=|==|!=|=~|!~|[-+*/<>=(){},])/.exec(input.slice(i));
    if (!op) throw new Error(`promql-eval: unexpected ${JSON.stringify(c)} at ${i}`);
    tokens.push({ type: 'op', value: op[0] });
    i += op[0].length;
  }
  return tokens;
}

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'selector'; name?: string; matchers: [string, string, string][]; range?: number }
  | { kind: 'call'; fn: string; args: Node[]; by?: string[] }
  | { kind: 'binary'; op: string; bool: boolean; left: Node; right: Node };

const COMPARISONS = ['==', '!=', '>', '<', '>=', '<='];
const LEVELS: string[][] = [['and'], COMPARISONS, ['+', '-'], ['*', '/']];

function parse(input: string): Node {
  const tokens = tokenize(input);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (value: string) => {
    const t = peek();
    return t !== undefined && (t.type === 'op' || t.type === 'ident') && t.value === value;
  };
  const expect = (value: string) => {
    if (!isOp(value)) throw new Error(`promql-eval: expected ${value} at token ${pos}`);
    pos++;
  };
  const labelList = (): string[] => {
    expect('(');
    const names: string[] = [];
    while (!isOp(')')) {
      const t = tokens[pos++];
      if (t?.type !== 'ident') throw new Error('promql-eval: expected a label name');
      names.push(t.value);
      if (isOp(',')) pos++;
    }
    expect(')');
    return names;
  };
  const selector = (name?: string): Node => {
    const matchers: [string, string, string][] = [];
    if (isOp('{')) {
      pos++;
      while (!isOp('}')) {
        const label = tokens[pos++];
        const op = tokens[pos++];
        const value = tokens[pos++];
        if (label?.type !== 'ident' || op?.type !== 'op' || value?.type !== 'str') throw new Error('promql-eval: bad matcher');
        matchers.push([label.value, op.value, value.value]);
        if (isOp(',')) pos++;
      }
      expect('}');
    }
    const t = peek();
    const range = t?.type === 'dur' ? (pos++, t.value) : undefined;
    return { kind: 'selector', ...(name ? { name } : {}), matchers, ...(range ? { range } : {}) };
  };
  const primary = (): Node => {
    const t = tokens[pos];
    if (!t) throw new Error('promql-eval: unexpected end');
    if (t.type === 'num') {
      pos++;
      return { kind: 'num', value: t.value };
    }
    if (t.type === 'op' && t.value === '(') {
      pos++;
      const inner = expr(0);
      expect(')');
      return inner;
    }
    if (t.type === 'op' && t.value === '{') return selector();
    if (t.type === 'ident') {
      pos++;
      let by: string[] | undefined;
      if (isOp('by')) {
        pos++;
        by = labelList();
      }
      if (isOp('(')) {
        pos++;
        const args: Node[] = [];
        while (!isOp(')')) {
          args.push(expr(0));
          if (isOp(',')) pos++;
        }
        expect(')');
        if (isOp('by')) {
          pos++;
          by = labelList();
        }
        return { kind: 'call', fn: t.value, args, ...(by ? { by } : {}) };
      }
      return selector(t.value);
    }
    throw new Error(`promql-eval: unexpected token ${JSON.stringify(t)}`);
  };
  const expr = (level: number): Node => {
    if (level === LEVELS.length) return primary();
    let left = expr(level + 1);
    for (;;) {
      const t = peek();
      if (!t || !(t.type === 'op' || t.type === 'ident') || !LEVELS[level]!.includes(t.value)) return left;
      pos++;
      let bool = false;
      if (isOp('bool')) {
        pos++;
        bool = true;
      }
      left = { kind: 'binary', op: t.value, bool, left, right: expr(level + 1) };
    }
  };
  const root = expr(0);
  if (pos !== tokens.length) throw new Error(`promql-eval: trailing input at token ${pos}`);
  return root;
}

function matches(labels: Labels, [label, op, value]: [string, string, string]): boolean {
  const actual = labels[label] ?? '';
  const re = () => new RegExp(`^(?:${value})$`);
  switch (op) {
    case '=':
      return actual === value;
    case '!=':
      return actual !== value;
    case '=~':
      return re().test(actual);
    case '!~':
      return !re().test(actual);
    default:
      throw new Error(`promql-eval: unknown matcher ${op}`);
  }
}

const key = (labels: Labels) => JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));

function withoutName(labels: Labels): Labels {
  return Object.fromEntries(Object.entries(labels).filter(([name]) => name !== '__name__'));
}

function arithmetic(op: string, a: number, b: number): number {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return a / b;
    default:
      throw new Error(`promql-eval: unknown operator ${op}`);
  }
}

function compare(op: string, a: number, b: number): boolean {
  switch (op) {
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    case '>':
      return a > b;
    case '<':
      return a < b;
    case '>=':
      return a >= b;
    case '<=':
      return a <= b;
    default:
      throw new Error(`promql-eval: unknown comparison ${op}`);
  }
}

/** Evaluates `expression` as an instant query at `time` (unix seconds) over `series`. */
export function evaluate(expression: string, series: readonly Series[], time: number): Sample[] {
  const select = (node: Extract<Node, { kind: 'selector' }>) =>
    series.filter((s) => (node.name === undefined || s.labels.__name__ === node.name) && node.matchers.every((m) => matches(s.labels, m)));

  const run = (node: Node): Value => {
    switch (node.kind) {
      case 'num':
        return { kind: 'scalar', value: node.value };
      case 'selector': {
        if (node.range !== undefined) throw new Error('promql-eval: a range vector outside rate() or increase()');
        const samples: Sample[] = [];
        for (const s of select(node)) {
          const last = s.points.filter(([t]) => t <= time && t > time - 300).at(-1);
          if (last) samples.push({ labels: s.labels, value: last[1] });
        }
        return { kind: 'vector', samples };
      }
      case 'call': {
        if (node.fn === 'min_over_time' || node.fn === 'absent_over_time') {
          const arg = node.args[0];
          if (arg?.kind !== 'selector' || arg.range === undefined) throw new Error(`promql-eval: ${node.fn}() needs a range selector`);
          const range = arg.range;
          const inRange = select(arg)
            .map((s) => ({ labels: withoutName(s.labels), values: s.points.filter(([t]) => t > time - range && t <= time).map(([, v]) => v) }))
            .filter((s) => s.values.length > 0);
          if (node.fn === 'min_over_time') return { kind: 'vector', samples: inRange.map((s) => ({ labels: s.labels, value: Math.min(...s.values) })) };
          // absent_over_time: 1, labelled with the selector's equality matchers, when nothing matched in the range.
          const labels = Object.fromEntries(arg.matchers.filter(([, op]) => op === '=').map(([label, , value]) => [label, value]));
          return { kind: 'vector', samples: inRange.length === 0 ? [{ labels, value: 1 }] : [] };
        }
        if (node.fn === 'rate' || node.fn === 'increase') {
          const arg = node.args[0];
          if (arg?.kind !== 'selector' || arg.range === undefined) throw new Error(`promql-eval: ${node.fn}() needs a range selector`);
          const range = arg.range;
          const samples: Sample[] = [];
          for (const s of select(arg)) {
            const inside = s.points.filter(([t]) => t > time - range && t <= time);
            if (inside.length < 2) continue;
            const increase = inside.at(-1)![1] - inside[0]![1];
            samples.push({ labels: withoutName(s.labels), value: node.fn === 'rate' ? increase / range : increase });
          }
          return { kind: 'vector', samples };
        }
        if (node.fn === 'sum' || node.fn === 'max') {
          const arg = node.args[0] ? run(node.args[0]) : undefined;
          if (arg?.kind !== 'vector') throw new Error(`promql-eval: ${node.fn}() needs a vector`);
          const groups = new Map<string, Sample>();
          for (const sample of arg.samples) {
            const labels = Object.fromEntries((node.by ?? []).filter((l) => sample.labels[l] !== undefined).map((l) => [l, sample.labels[l]!]));
            const group = groups.get(key(labels));
            if (group) group.value = node.fn === 'sum' ? group.value + sample.value : Math.max(group.value, sample.value);
            else groups.set(key(labels), { labels, value: sample.value });
          }
          return { kind: 'vector', samples: [...groups.values()] };
        }
        throw new Error(`promql-eval: unsupported function ${node.fn}()`);
      }
      case 'binary': {
        const left = run(node.left);
        const right = run(node.right);
        if (node.op === 'and') {
          if (left.kind !== 'vector' || right.kind !== 'vector') throw new Error('promql-eval: and needs two vectors');
          const keys = new Set(right.samples.map((s) => key(s.labels)));
          return { kind: 'vector', samples: left.samples.filter((s) => keys.has(key(s.labels))) };
        }
        const isComparison = COMPARISONS.includes(node.op);
        if (left.kind === 'scalar' && right.kind === 'scalar') {
          if (isComparison) return { kind: 'scalar', value: compare(node.op, left.value, right.value) ? 1 : 0 };
          return { kind: 'scalar', value: arithmetic(node.op, left.value, right.value) };
        }
        const pairs: [Sample, number, number][] = [];
        if (left.kind === 'vector' && right.kind === 'vector') {
          const byKey = new Map(right.samples.map((s) => [key(s.labels), s]));
          for (const s of left.samples) {
            const other = byKey.get(key(s.labels));
            if (other) pairs.push([s, s.value, other.value]);
          }
        } else if (left.kind === 'vector' && right.kind === 'scalar') {
          for (const s of left.samples) pairs.push([s, s.value, right.value]);
        } else if (left.kind === 'scalar' && right.kind === 'vector') {
          for (const s of right.samples) pairs.push([s, left.value, s.value]);
        }
        const samples: Sample[] = [];
        for (const [sample, a, b] of pairs) {
          const labels = withoutName(sample.labels);
          if (!isComparison) samples.push({ labels, value: arithmetic(node.op, a, b) });
          else if (node.bool) samples.push({ labels, value: compare(node.op, a, b) ? 1 : 0 });
          // A filtering comparison keeps the vector side's value.
          else if (compare(node.op, a, b)) samples.push({ labels, value: left.kind === 'vector' ? a : b });
        }
        return { kind: 'vector', samples };
      }
    }
  };

  const result = run(parse(expression));
  return result.kind === 'vector' ? result.samples : [{ labels: {}, value: result.value }];
}

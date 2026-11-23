// Instrumentation lint, ported from the exemplar-shop's scripts/instrument-lint.ts @ 12a071e with the
// paths moved from apps/backend to apps/api (spec §4.3). The rules (:5-16):
//
//   - apps/api/src/common imports @getworkdone/telemetry, registers RedInterceptor as
//     APP_INTERCEPTOR and FinalStatusFilter as APP_FILTER (the RED status fix);
//   - red.interceptor.ts and final-status.filter.ts call recordHttpServerRequest and log the route
//     and status_code of each request;
//   - any file under apps/api/src/modules that makes outbound HTTP calls (fetch or an HTTP client
//     import, :30) wraps them in withSpan.
//
// GWP#6 tightens the last rule for fetch: each fetch call (`fetch(...)`, `x.fetch(...)`) must sit inside a
// callback passed to withSpan, found from the file's syntax tree, so a fetch moved out of its span fails
// even when the file still calls withSpan elsewhere.
//
// The exemplar's user_role and synthetic log fields belong to the shop and are not checked.
//
//   pnpm exec tsx scripts/instrument-lint.ts [--root <repo root>]

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const COMMON = 'apps/api/src/common';
const MODULES = 'apps/api/src/modules';
const RECORDING_FILES = ['red.interceptor.ts', 'final-status.filter.ts'];
const HTTP_CLIENT = /\bfetch\s*\(|from\s+['"](?:axios|got|undici|node-fetch|node:https?|https?)['"]/;

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

const isCalled = (call: ts.CallExpression, name: string): boolean => {
  const callee = call.expression;
  return (ts.isIdentifier(callee) && callee.text === name) || (ts.isPropertyAccessExpression(callee) && callee.name.text === name);
};

/** True when `node` is inside a function passed to withSpan (any argument after its span name). */
function insideWithSpan(node: ts.Node): boolean {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isCallExpression(parent) && isCalled(parent, 'withSpan') && parent.arguments.indexOf(child as ts.Expression) > 0) return true;
  }
  return false;
}

/** Each fetch call in `text` outside withSpan, as "<line>: <callee>() is called outside withSpan". */
function fetchesOutsideSpans(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isCalled(node, 'fetch') && !insideWithSpan(node)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      found.push(`${line}: ${node.expression.getText(source)}() is called outside withSpan`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every violation under `root`, as "<path>: <problem>" lines. */
export function lint(root: string): string[] {
  const problems: string[] = [];
  const common = sourceFiles(join(root, COMMON)).map((path) => ({ path, text: readFileSync(path, 'utf8') }));
  const all = common.map((f) => f.text).join('\n');

  if (!common.some((f) => /from\s+['"]@getworkdone\/telemetry['"]/.test(f.text))) problems.push(`${COMMON}: no file imports @getworkdone/telemetry`);
  if (!/provide:\s*APP_INTERCEPTOR,\s*useClass:\s*RedInterceptor\b/.test(all)) problems.push(`${COMMON}: RedInterceptor must be registered as APP_INTERCEPTOR`);
  if (!/provide:\s*APP_FILTER,\s*useClass:\s*FinalStatusFilter\b/.test(all)) problems.push(`${COMMON}: FinalStatusFilter must be registered as APP_FILTER`);

  for (const name of RECORDING_FILES) {
    const path = `${COMMON}/${name}`;
    const file = common.find((f) => relative(root, f.path) === path);
    if (!file) {
      problems.push(`${path}: missing`);
      continue;
    }
    if (!/\brecordHttpServerRequest\s*\(/.test(file.text)) problems.push(`${path}: must call recordHttpServerRequest`);
    if (!/\broute\b[,}]/.test(file.text)) problems.push(`${path}: must log route`);
    if (!/\bstatus_code:/.test(file.text)) problems.push(`${path}: must log status_code`);
  }

  for (const path of sourceFiles(join(root, MODULES))) {
    const text = readFileSync(path, 'utf8');
    if (!HTTP_CLIENT.test(text)) continue;
    if (!/\bwithSpan\s*\(/.test(text)) problems.push(`${relative(root, path)}: makes outbound HTTP calls without withSpan`);
    else for (const problem of fetchesOutsideSpans(path, text)) problems.push(`${relative(root, path)}:${problem}`);
  }
  return problems;
}

export function main(args: readonly string[]): number {
  const index = args.indexOf('--root');
  const root = resolve(index === -1 ? fileURLToPath(new URL('../', import.meta.url)) : (args[index + 1] ?? '.'));
  const problems = lint(root);
  for (const problem of problems) process.stdout.write(`FAIL ${problem}\n`);
  process.stdout.write(problems.length === 0 ? 'instrument-lint: ok\n' : `instrument-lint: ${problems.length} problem(s)\n`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}

// Derive the observability coverage manifest's status from automated checks (GWP#7). The exemplar's
// "24/24 passing" was hand-edited YAML (specs/observability-coverage.yaml:41 @ 12a071e;
// prebutton.md:350); here a manifest entry names a check and never a status:
//
//   check: { kind: test, file: <test file>, test: <test title> }   passing iff that test passed in this
//                                                                  run's report; failing otherwise
//   check: { kind: live, query: <id in observability/live/queries.ts> }   pending-live; GWP#9 runs it
//
// Test results come from the reports the gates write (reports/vitest-unit.json, vitest-integration.json,
// playwright-e2e.json), chosen by the file name: *.integration.test.ts, tests/e2e/*.spec.ts, else unit.
// A missing report, a missing result or a skipped test counts as failing. The script writes
// reports/coverage-status.json; scripts/coverage-check.ts reads only that file.
//
//   pnpm exec tsx scripts/coverage-status.ts [--manifest <yaml>] [--reports <dir>] [--out <json>]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { liveQuery } from '../observability/live/queries.js';

export type CheckSpec = { kind: 'test'; file: string; test: string } | { kind: 'live'; query: string };
export type FeatureStatus = 'passing' | 'failing' | 'pending-live';

export interface ManifestFeature {
  id: string;
  name: unknown;
  slice: unknown;
  check: unknown;
}

export interface Manifest {
  features: ManifestFeature[];
  out_of_scope: { id: string; name: unknown; reason: unknown }[];
  /** Every `status` key in the document, with the entry it sits in; none is allowed. */
  statusKeys: { id: string; path: string }[];
  /** 1-based lines whose text holds `status:` (a comment included), as `grep -n "status:"` finds them. */
  statusLines: number[];
}

export interface StatusFile {
  manifest: string;
  generatedAt: string;
  features: { id: string; name: string; slice?: string; check: CheckSpec | null; status: FeatureStatus; detail: string }[];
  out_of_scope: { id: string; reason: string }[];
  problems: string[];
}

const LIVE_REGISTRY = 'observability/live/queries.ts';

function entries(list: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(list)) throw new Error(`manifest has no ${name} list`);
  return list.map((raw: unknown, index: number) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    if (typeof entry.id !== 'string' || entry.id === '') throw new Error(`${name}[${index}] has no id`);
    return entry;
  });
}

/** The manifest's two lists; throws when either is missing or an entry has no id. */
export function parseManifest(text: string): Manifest {
  const doc = parse(text) as Record<string, unknown> | null;
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('manifest has no features list');
  const features = entries(doc.features, 'features').map((f) => ({ id: f.id as string, name: f.name, slice: f.slice, check: f.check }));
  const outOfScope = entries(doc.out_of_scope, 'out_of_scope').map((o) => ({ id: o.id as string, name: o.name, reason: o.reason }));
  const statusLines = text.split('\n').flatMap((line, index) => (line.includes('status:') ? [index + 1] : []));
  return { features, out_of_scope: outOfScope, statusKeys: statusKeys(doc), statusLines };
}

/** Every `status` key at any depth, with the id of the feature or out_of_scope entry it sits in. */
function statusKeys(doc: Record<string, unknown>): { id: string; path: string }[] {
  const found: { id: string; path: string }[] = [];
  const walk = (value: unknown, path: string, id: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const entryId = (path === 'features' || path === 'out_of_scope') && typeof (item as { id?: unknown } | null)?.id === 'string' ? (item as { id: string }).id : id;
        walk(item, `${path}[${index}]`, entryId);
      });
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const childPath = path ? `${path}.${key}` : key;
        if (key === 'status') found.push({ id, path: childPath });
        walk(child, childPath, id);
      }
    }
  };
  walk(doc, '', 'manifest');
  return found;
}

/** The entry's check, or the reason it is not a valid one. */
function readCheck(raw: unknown, root: string): CheckSpec | string {
  if (raw === undefined || raw === null) return 'needs a check (kind test or kind live)';
  const check = raw as Record<string, unknown>;
  if (check.kind === 'test') {
    if (typeof check.file !== 'string' || typeof check.test !== 'string' || check.test === '') return 'a test check needs file and test';
    if (!existsSync(join(root, check.file))) return `check file ${check.file} does not exist`;
    if (!readFileSync(join(root, check.file), 'utf8').includes(check.test)) return `check test "${check.test}" is not in ${check.file}`;
    return { kind: 'test', file: check.file, test: check.test };
  }
  if (check.kind === 'live') {
    if (typeof check.query !== 'string' || !liveQuery(check.query)) return `live query ${String(check.query)} is not in ${LIVE_REGISTRY}`;
    return { kind: 'live', query: check.query };
  }
  return 'check kind must be test or live';
}

/** Every rule the manifest itself breaks, as "<id>: <problem>", before any check runs. */
export function manifestProblems(manifest: Manifest, root: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const id of [...manifest.features, ...manifest.out_of_scope].map((e) => e.id)) {
    if (seen.has(id)) problems.push(`${id}: duplicate id`);
    seen.add(id);
  }
  for (const key of manifest.statusKeys) {
    problems.push(`${key.id}: status: is set by hand at ${key.path}; remove it, coverage-status derives status from the check`);
  }
  // The YAML parser skips comments; the text check keeps `grep -n "status:"` empty too.
  if (manifest.statusKeys.length === 0) {
    for (const line of manifest.statusLines) problems.push(`manifest: status: appears in the text at line ${line}; the manifest never carries a status, not even in a comment`);
  }
  for (const feature of manifest.features) {
    const check = readCheck(feature.check, root);
    if (typeof check === 'string') problems.push(`${feature.id}: ${check}`);
  }
  return problems;
}

type Outcome = 'passed' | 'failed' | 'skipped';

interface VitestReport {
  testResults?: { name: string; assertionResults?: { title: string; status: string }[] }[];
}

interface PlaywrightSuite {
  file?: string;
  specs?: { title: string; file?: string; ok?: boolean; tests?: { status?: string }[] }[];
  suites?: PlaywrightSuite[];
}

function reportFor(file: string): string {
  if (file.endsWith('.integration.test.ts')) return 'vitest-integration.json';
  if (file.startsWith('tests/e2e/')) return 'playwright-e2e.json';
  return 'vitest-unit.json';
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The outcome of one test in one report, or a reason it has none. */
function outcome(check: { file: string; test: string }, reportsDir: string, root: string): Outcome | string {
  const reportName = reportFor(check.file);
  const reportPath = join(reportsDir, reportName);
  if (!existsSync(reportPath)) return `no ${reportName} in ${reportsDir}: run the partition that holds ${check.file} first`;
  if (reportName === 'playwright-e2e.json') {
    // Playwright names spec files relative to its testDir, tests/e2e.
    const specFile = relative('tests/e2e', check.file).split(sep).join('/');
    const found: Outcome[] = [];
    const walk = (suite: PlaywrightSuite, file: string | undefined) => {
      const here = suite.file ?? file;
      for (const spec of suite.specs ?? []) {
        if ((spec.file ?? here) !== specFile || spec.title !== check.test) continue;
        const statuses = (spec.tests ?? []).map((t) => t.status);
        found.push(statuses.length > 0 && statuses.every((s) => s === 'skipped') ? 'skipped' : spec.ok === true && !statuses.includes('skipped') ? 'passed' : 'failed');
      }
      for (const child of suite.suites ?? []) walk(child, here);
    };
    for (const suite of ((readJson(reportPath) as { suites?: PlaywrightSuite[] }).suites ?? [])) walk(suite, undefined);
    return combine(found, check, reportName);
  }
  const report = readJson(reportPath) as VitestReport;
  const target = resolve(root, check.file);
  const found = (report.testResults ?? [])
    .filter((r) => resolve(r.name) === target)
    .flatMap((r) => (r.assertionResults ?? []).filter((a) => a.title === check.test))
    .map((a): Outcome => (a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped'));
  return combine(found, check, reportName);
}

function combine(found: Outcome[], check: { file: string; test: string }, reportName: string): Outcome | string {
  if (found.length === 0) return `no result for "${check.test}" (${check.file}) in ${reportName}`;
  if (found.includes('failed')) return 'failed';
  if (found.includes('skipped')) return 'skipped';
  return 'passed';
}

/** Run every check of a parsed manifest against the reports in `reportsDir`. */
export function buildStatus(manifest: Manifest, root: string, reportsDir: string, manifestPath: string): StatusFile {
  const features = manifest.features.map((feature) => {
    const check = readCheck(feature.check, root);
    const base = { id: feature.id, name: String(feature.name ?? ''), ...(typeof feature.slice === 'string' ? { slice: feature.slice } : {}) };
    if (typeof check === 'string') return { ...base, check: null, status: 'failing' as const, detail: check };
    if (check.kind === 'live') return { ...base, check, status: 'pending-live' as const, detail: `live query ${check.query}; enforced after deploy (GWP#9)` };
    const result = outcome(check, reportsDir, root);
    if (result === 'passed') return { ...base, check, status: 'passing' as const, detail: `${check.file}: ${check.test}` };
    return { ...base, check, status: 'failing' as const, detail: result === 'failed' || result === 'skipped' ? `test ${result}: ${check.file}: ${check.test}` : result };
  });
  return {
    manifest: manifestPath,
    generatedAt: new Date().toISOString(),
    features,
    out_of_scope: manifest.out_of_scope.map((o) => ({ id: o.id, reason: String(o.reason ?? '') })),
    problems: manifestProblems(manifest, root),
  };
}

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function main(args: readonly string[]): number {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifestPath = resolve(argValue(args, '--manifest') ?? resolve(root, 'specs/observability-coverage.yaml'));
  const reportsDir = resolve(argValue(args, '--reports') ?? resolve(root, 'reports'));
  const out = resolve(argValue(args, '--out') ?? resolve(root, 'reports/coverage-status.json'));
  let manifest: Manifest;
  try {
    manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    process.stderr.write(`coverage-status: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const status = buildStatus(manifest, root, reportsDir, manifestPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(status, null, 2)}\n`);
  for (const feature of status.features) process.stdout.write(`${feature.status} ${feature.id}: ${feature.detail}\n`);
  for (const problem of status.problems) process.stdout.write(`problem ${problem}\n`);
  process.stdout.write(`coverage-status: wrote ${out}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}

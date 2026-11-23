// Observability coverage gate, ported from the exemplar-shop's scripts/coverage-check.ts @ 12a071e,
// which passed a feature when its hand-set status was `passing` (:186-198). GWP#7 replaces the hand-set
// status: scripts/coverage-status.ts runs each manifest entry's check and writes
// reports/coverage-status.json, and this gate reads only that file (prebutton.md:350). It fails when:
//
//   - the status file is missing or malformed, or lists manifest problems (a `status:` set by hand, a
//     check that names no test, an unknown live query, a duplicate id);
//   - a feature is `failing`; with --require-live (GWP#9, after deploy) a feature still `pending-live`;
//   - the GetWorkDone rules (D-026) break: beyla-ebpf and host-infra-metrics must stay under
//     out_of_scope with the reason "Fargate: no eBPF and no host access" and never be features;
//     ecs-container-insights and alb-metrics, their replacements, must be features.
//
// The rules are in this file, not in the editable YAML, so editing the manifest cannot relax them.
//
//   pnpm exec tsx scripts/coverage-check.ts [--status <json>] [--require-live]

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { StatusFile } from './coverage-status.js';

export const FARGATE_REASON = 'Fargate: no eBPF and no host access';
const OUT_OF_SCOPE_ON_FARGATE = ['beyla-ebpf', 'host-infra-metrics'];
const REQUIRED_FEATURES = ['ecs-container-insights', 'alb-metrics'];
const STATUSES = ['passing', 'failing', 'pending-live'];

export interface Failure {
  id: string;
  problem: string;
}

function readStatus(path: string): StatusFile {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StatusFile> | null;
  const ok =
    parsed !== null &&
    Array.isArray(parsed.features) &&
    Array.isArray(parsed.out_of_scope) &&
    Array.isArray(parsed.problems) &&
    parsed.features.every((f) => typeof f?.id === 'string' && STATUSES.includes(f.status));
  if (!ok) throw new Error(`${path} is not a status file written by scripts/coverage-status.ts`);
  return parsed as StatusFile;
}

/** Every rule the status breaks: manifest problems, failing features, then the fixed GetWorkDone rules. */
export function checkStatus(status: StatusFile, options: { requireLive: boolean }): Failure[] {
  const failures: Failure[] = status.problems.map((p) => {
    const split = p.indexOf(': ');
    return split > 0 ? { id: p.slice(0, split), problem: p.slice(split + 2) } : { id: '(manifest)', problem: p };
  });
  const reported = new Set(failures.map((f) => f.id));
  for (const feature of status.features) {
    if (reported.has(feature.id)) continue;
    if (feature.status === 'failing') failures.push({ id: feature.id, problem: `test check failing: ${feature.detail}` });
    else if (feature.status === 'pending-live' && options.requireLive) failures.push({ id: feature.id, problem: `live check pending: ${feature.detail}` });
  }
  const featureIds = new Set(status.features.map((f) => f.id));
  for (const id of OUT_OF_SCOPE_ON_FARGATE) {
    const entry = status.out_of_scope.find((o) => o.id === id);
    if (!entry) failures.push({ id, problem: 'must be listed under out_of_scope (D-026)' });
    else if (entry.reason !== FARGATE_REASON) failures.push({ id, problem: `reason must be "${FARGATE_REASON}"` });
    if (featureIds.has(id)) failures.push({ id, problem: 'must not be a feature: Fargate permits no eBPF (D-026)' });
  }
  for (const id of REQUIRED_FEATURES) {
    if (!featureIds.has(id)) failures.push({ id, problem: 'must be listed under features (D-026)' });
  }
  return failures;
}

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function main(args: readonly string[]): number {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const statusPath = resolve(argValue(args, '--status') ?? resolve(root, 'reports/coverage-status.json'));
  if (!existsSync(statusPath)) {
    process.stderr.write(`coverage-check: no ${statusPath}; run scripts/coverage-status.ts first\n`);
    return 1;
  }
  let status: StatusFile;
  try {
    status = readStatus(statusPath);
  } catch (error) {
    process.stderr.write(`coverage-check: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const failures = checkStatus(status, { requireLive: args.includes('--require-live') });
  const failed = new Set(failures.map((f) => f.id));
  for (const feature of status.features) {
    if (!failed.has(feature.id)) process.stdout.write(`PASS ${feature.id} (${feature.status})\n`);
  }
  for (const failure of failures) process.stdout.write(`FAIL ${failure.id}: ${failure.problem}\n`);
  if (failures.length > 0) {
    process.stdout.write(`coverage-check: ${failures.length} problem(s) in ${statusPath}\n`);
    return 1;
  }
  const pending = status.features.filter((f) => f.status === 'pending-live').length;
  process.stdout.write(`coverage-check: ok (${status.features.length} features, ${pending} pending-live, ${status.out_of_scope.length} out of scope)\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}

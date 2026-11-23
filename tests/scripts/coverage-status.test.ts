import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { main as checkMain } from '../../scripts/coverage-check.js';
import { buildStatus, main, manifestProblems, parseManifest, type StatusFile } from '../../scripts/coverage-status.js';
import { runMain } from './support.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const FARGATE = 'Fargate: no eBPF and no host access';
const OTEL_FILE = 'packages/telemetry/src/otel.test.ts';
const OTEL_TEST = 'an exported span carries service.name, service.version, deployment.environment and prebutton.instance';
const E2E_FILE = 'tests/e2e/smoke.spec.ts';
const E2E_TEST = '/ shows GetWorkDone, and the API span joins the browser traceparent trace';

const BASE_FEATURES = `  - id: otel-traces
    name: Spans
    check:
      kind: test
      file: ${OTEL_FILE}
      test: "${OTEL_TEST}"
  - id: ecs-container-insights
    name: ECS Container Insights
    slice: "#8"
    check:
      kind: live
      query: ecs-container-insights
  - id: alb-metrics
    name: ALB metrics
    slice: "#8"
    check:
      kind: live
      query: alb-metrics`;

const OUT_OF_SCOPE = `  - id: beyla-ebpf
    name: Beyla
    reason: "${FARGATE}"
  - id: host-infra-metrics
    name: Host metrics
    reason: "${FARGATE}"`;

function manifest(extra = '', features = BASE_FEATURES): string {
  return `features:\n${features}${extra ? `\n${extra}` : ''}\nout_of_scope:\n${OUT_OF_SCOPE}\n`;
}

type Outcome = 'passed' | 'failed' | 'skipped';

/** A reports directory holding a vitest unit report and a Playwright report with the given outcomes. */
function reports(unit: Record<string, Outcome> = { [OTEL_TEST]: 'passed' }, e2e: Record<string, Outcome> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'reports-'));
  const assertionResults = Object.entries(unit).map(([title, status]) => ({ ancestorTitles: ['otel'], fullName: `otel ${title}`, title, status }));
  writeFileSync(join(dir, 'vitest-unit.json'), JSON.stringify({ testResults: [{ name: join(root, OTEL_FILE), assertionResults }] }));
  const specs = Object.entries(e2e).map(([title, status]) => ({
    title,
    ok: status === 'passed',
    tests: [{ status: status === 'passed' ? 'expected' : status === 'skipped' ? 'skipped' : 'unexpected' }],
  }));
  writeFileSync(join(dir, 'playwright-e2e.json'), JSON.stringify({ suites: [{ title: 'smoke.spec.ts', file: 'smoke.spec.ts', specs, suites: [] }] }));
  return dir;
}

function status(text: string, reportsDir = reports()): StatusFile {
  return buildStatus(parseManifest(text), root, reportsDir, 'm.yaml');
}

function feature(file: StatusFile, id: string) {
  return file.features.find((f) => f.id === id)!;
}

/** Run coverage-status then coverage-check on a manifest, as CI does. */
function pipeline(text: string, reportsDir = reports(), checkArgs: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'cov-'));
  writeFileSync(join(dir, 'm.yaml'), text);
  const out = join(dir, 'coverage-status.json');
  const statusRun = runMain(main, ['--manifest', join(dir, 'm.yaml'), '--reports', reportsDir, '--out', out]);
  const checkRun = runMain(checkMain, ['--status', out, ...checkArgs]);
  return { statusRun, checkRun, out };
}

describe('coverage-status', () => {
  it('the repo manifest, specs/observability-coverage.yaml, is well formed and sets no status by hand', () => {
    const text = readFileSync(join(root, 'specs/observability-coverage.yaml'), 'utf8');
    expect(text).not.toMatch(/status:/);
    expect(manifestProblems(parseManifest(text), root)).toEqual([]);
  });

  it('a passing test check turns its feature passing and a live check reports pending-live', () => {
    const file = status(manifest());
    expect(feature(file, 'otel-traces')).toMatchObject({ status: 'passing' });
    expect(feature(file, 'ecs-container-insights')).toMatchObject({ status: 'pending-live', slice: '#8' });
    expect(file.problems).toEqual([]);
    const { statusRun, checkRun, out } = pipeline(manifest());
    expect(statusRun.status).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8')).features).toHaveLength(3);
    expect(checkRun.stdout).toContain('PASS otel-traces (passing)');
    expect(checkRun.stdout).toContain('PASS alb-metrics (pending-live)');
    expect(checkRun.status).toBe(0);
  });

  it('a failing test check turns its feature failing and coverage-check exits 1', () => {
    const failed = reports({ [OTEL_TEST]: 'failed' });
    expect(feature(status(manifest(), failed), 'otel-traces')).toMatchObject({ status: 'failing' });
    const { checkRun } = pipeline(manifest(), failed);
    expect(checkRun.status).toBe(1);
    expect(checkRun.stdout).toContain('FAIL otel-traces: test check failing');
  });

  it('a skipped test, a test missing from the report and a missing report all count as failing', () => {
    expect(feature(status(manifest(), reports({ [OTEL_TEST]: 'skipped' })), 'otel-traces').status).toBe('failing');
    expect(feature(status(manifest(), reports({ other: 'passed' })), 'otel-traces').status).toBe('failing');
    const empty = mkdtempSync(join(tmpdir(), 'reports-'));
    const missing = feature(status(manifest(), empty), 'otel-traces');
    expect(missing.status).toBe('failing');
    expect(missing.detail).toContain('vitest-unit.json');
  });

  it('a manifest containing status: fails coverage-check', () => {
    const text = manifest('', BASE_FEATURES.replace('    name: Spans\n', '    name: Spans\n    status: passing\n'));
    expect(manifestProblems(parseManifest(text), root)).toEqual(['otel-traces: status: is set by hand at features[0].status; remove it, coverage-status derives status from the check']);
    const { checkRun } = pipeline(text);
    expect(checkRun.status).toBe(1);
    expect(checkRun.stdout).toContain('FAIL otel-traces: status: is set by hand');
  });

  it('a status: anywhere in the manifest fails coverage-check, not only on a feature', () => {
    const inCheck = manifest('', BASE_FEATURES.replace('      kind: test\n', '      kind: test\n      status: passing\n'));
    const onOutOfScope = manifest().replace('    name: Beyla\n', '    name: Beyla\n    status: passing\n');
    const topLevel = `status: passing\n${manifest()}`;
    const inComment = `# status: passing\n${manifest()}`;
    expect(manifestProblems(parseManifest(inComment), root)).toEqual(['manifest: status: appears in the text at line 1; the manifest never carries a status, not even in a comment']);
    expect(manifestProblems(parseManifest(inCheck), root)).toEqual(['otel-traces: status: is set by hand at features[0].check.status; remove it, coverage-status derives status from the check']);
    expect(manifestProblems(parseManifest(onOutOfScope), root)).toEqual(['beyla-ebpf: status: is set by hand at out_of_scope[0].status; remove it, coverage-status derives status from the check']);
    expect(manifestProblems(parseManifest(topLevel), root)).toEqual(['manifest: status: is set by hand at status; remove it, coverage-status derives status from the check']);
    for (const text of [inCheck, onOutOfScope, topLevel, inComment]) {
      const { checkRun } = pipeline(text);
      expect(checkRun.status).toBe(1);
      expect(checkRun.stdout).toMatch(/FAIL [\w-]+: status: /);
    }
  });

  it('reads Playwright and integration reports by the check file name', () => {
    const e2e = `  - id: traces-propagation
    name: traceparent
    check:
      kind: test
      file: ${E2E_FILE}
      test: "${E2E_TEST}"`;
    expect(feature(status(manifest(e2e), reports(undefined, { [E2E_TEST]: 'passed' })), 'traces-propagation').status).toBe('passing');
    expect(feature(status(manifest(e2e), reports(undefined, { [E2E_TEST]: 'failed' })), 'traces-propagation').status).toBe('failing');

    // GWP#59: CI retries a failed spec once (playwright.config.ts). A spec that fails and then passes is
    // `flaky`, with `ok: true`, and counts as passing; the list reporter's flaky marker is the record.
    // One that fails both attempts is `unexpected`, with `ok: false`.
    const retried = (second: 'passed' | 'failed') => {
      const dir = reports();
      const results = [{ retry: 0, status: 'failed' }, { retry: 1, status: second }];
      const spec = { title: E2E_TEST, ok: second === 'passed', tests: [{ status: second === 'passed' ? 'flaky' : 'unexpected', results }] };
      writeFileSync(join(dir, 'playwright-e2e.json'), JSON.stringify({ suites: [{ title: 'smoke.spec.ts', file: 'smoke.spec.ts', specs: [spec], suites: [] }] }));
      return dir;
    };
    expect(feature(status(manifest(e2e), retried('passed')), 'traces-propagation').status).toBe('passing');
    expect(feature(status(manifest(e2e), retried('failed')), 'traces-propagation').status).toBe('failing');

    const integration = `  - id: red-metrics
    name: RED
    check:
      kind: test
      file: apps/api/test/red.integration.test.ts
      test: "a handler throwing a 500 records status_class=\\"5xx\\" in http_server_requests_total, never 2xx"`;
    const dir = reports();
    const title = 'a handler throwing a 500 records status_class="5xx" in http_server_requests_total, never 2xx';
    writeFileSync(join(dir, 'vitest-integration.json'), JSON.stringify({ testResults: [{ name: join(root, 'apps/api/test/red.integration.test.ts'), assertionResults: [{ title, fullName: `red ${title}`, status: 'passed' }] }] }));
    expect(feature(status(manifest(integration), dir), 'red-metrics').status).toBe('passing');
  });

  it('rejects a check that names a missing file, a test not in the file, an unknown live query or no check at all', () => {
    const entry = (check: string) => manifest(`  - id: x\n    name: X\n${check}`);
    const problems = (text: string) => manifestProblems(parseManifest(text), root);
    expect(problems(entry(''))).toEqual(['x: needs a check (kind test or kind live)']);
    expect(problems(entry('    check:\n      kind: test\n      file: nowhere.test.ts\n      test: t'))).toEqual(['x: check file nowhere.test.ts does not exist']);
    expect(problems(entry(`    check:\n      kind: test\n      file: ${OTEL_FILE}\n      test: no such test`))).toEqual([`x: check test "no such test" is not in ${OTEL_FILE}`]);
    expect(problems(entry('    check:\n      kind: live\n      query: no-such-query'))).toEqual(['x: live query no-such-query is not in observability/live/queries.ts']);
    expect(problems(entry('    check:\n      kind: guess'))).toEqual(['x: check kind must be test or live']);
    const { checkRun } = pipeline(entry(''));
    expect(checkRun.status).toBe(1);
  });

  it('exits 1 without writing when the manifest cannot be read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cov-'));
    writeFileSync(join(dir, 'm.yaml'), 'nope: 1\n');
    const result = runMain(main, ['--manifest', join(dir, 'm.yaml'), '--reports', dir, '--out', join(dir, 'out.json')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('coverage-status:');
    expect(() => parseManifest('features: []\n')).toThrow('out_of_scope');
  });
});

describe('coverage-check reads only coverage-status.json', () => {
  it('exits 1 when the status file is missing, naming coverage-status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cov-'));
    const result = runMain(checkMain, ['--status', join(dir, 'absent.json')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('run scripts/coverage-status.ts first');
  });

  it('with --require-live, a pending-live feature fails (#9 enforces live checks after deploy)', () => {
    const { checkRun } = pipeline(manifest(), reports(), ['--require-live']);
    expect(checkRun.status).toBe(1);
    expect(checkRun.stdout).toContain('FAIL alb-metrics: live check pending');
  });

  it('exits 1 if beyla-ebpf or host-infra-metrics leaves out_of_scope or changes its reason', () => {
    const text = manifest().replace(`  - id: beyla-ebpf\n    name: Beyla\n    reason: "${FARGATE}"\n`, '');
    const { checkRun } = pipeline(text);
    expect(checkRun.status).toBe(1);
    expect(checkRun.stdout).toContain('FAIL beyla-ebpf: must be listed under out_of_scope (D-026)');
    const reason = pipeline(manifest().replace(`name: Beyla\n    reason: "${FARGATE}"`, 'name: Beyla\n    reason: later'));
    expect(reason.checkRun.stdout).toContain(`FAIL beyla-ebpf: reason must be "${FARGATE}"`);
  });

  it('exits 1 if beyla-ebpf moves into features, even when still listed out of scope', () => {
    const { checkRun } = pipeline(manifest('  - id: beyla-ebpf\n    name: Beyla\n    slice: "#8"\n    check:\n      kind: live\n      query: alb-metrics'));
    expect(checkRun.stdout).toContain('FAIL beyla-ebpf: must not be a feature: Fargate permits no eBPF (D-026)');
    expect(checkRun.status).toBe(1);
  });

  it('exits 1 if ecs-container-insights or alb-metrics is missing, or an id repeats', () => {
    const noAlb = manifest('', BASE_FEATURES.split('  - id: alb-metrics')[0]!.trimEnd());
    expect(pipeline(noAlb).checkRun.stdout).toContain('FAIL alb-metrics: must be listed under features (D-026)');
    const dup = pipeline(manifest('  - id: alb-metrics\n    name: again\n    check:\n      kind: live\n      query: alb-metrics'));
    expect(dup.checkRun.stdout).toContain('FAIL alb-metrics: duplicate id');
    expect(dup.checkRun.status).toBe(1);
  });

  it('exits 1 on a status file that is not one coverage-status wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cov-'));
    mkdirSync(join(dir, 'r'));
    writeFileSync(join(dir, 'bad.json'), '{"features": 3}');
    const result = runMain(checkMain, ['--status', join(dir, 'bad.json')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('coverage-check:');
  });
});

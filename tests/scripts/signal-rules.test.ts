import { describe, expect, it } from 'vitest';
import { signalRules } from '../../observability/signals/definitions.js';
import { evaluate, type Series } from './promql-eval.js';

// Partition `unit`: the <env>-signals rules (GWP#53) run through the test PromQL evaluator over recorded
// samples, as Grafana would evaluate them every minute. Every rule fires when its query returns a sample
// above 0 (the shared `gt 0` condition); an empty result is NoData, which noDataState OK keeps Normal.

const NOW = 100_000;
const ENV = 'getworkdone-dev';
const STEP = 15;

function expr(name: string): string {
  return signalRules(ENV).find((r) => r.title === `${ENV} ${name}`)!.expr;
}

/** One series sampled every 15 s over the last 2 hours; `value(t)` gives each sample, undefined skips it. */
function series(name: string, labels: Record<string, string>, value: (t: number) => number | undefined): Series {
  const points: [number, number][] = [];
  for (let t = NOW - 7200; t <= NOW; t += STEP) {
    const v = value(t);
    if (v !== undefined) points.push([t, v]);
  }
  return { labels: { __name__: name, deployment_environment: ENV, ...labels }, points };
}

/** Fires as the rule's condition would: some sample above 0. */
const fires = (result: { value: number }[]) => result.some((s) => s.value > 0);

describe('signal rules over recorded samples (GWP#53)', () => {
  it('telemetry heartbeat: empty (NoData, kept Normal) while the purge series arrives; 1 once it has been absent for 10 minutes', () => {
    const live = [series('session_purge_runs_total', { status: 'ok' }, (t) => Math.floor((t - (NOW - 7200)) / 900) + 1)];
    expect(evaluate(expr('telemetry heartbeat'), live, NOW)).toEqual([]);
    const stoppedEleven = [series('session_purge_runs_total', { status: 'ok' }, (t) => (t <= NOW - 660 ? 1 : undefined))];
    expect(evaluate(expr('telemetry heartbeat'), stoppedEleven, NOW)).toEqual([{ labels: { deployment_environment: ENV }, value: 1 }]);
    const stoppedFive = [series('session_purge_runs_total', { status: 'ok' }, (t) => (t <= NOW - 300 ? 1 : undefined))];
    expect(evaluate(expr('telemetry heartbeat'), stoppedFive, NOW)).toEqual([]);
    // Another environment's series never keeps this one quiet.
    const other = [{ ...live[0]!, labels: { ...live[0]!.labels, deployment_environment: 'getworkdone' } }];
    expect(fires(evaluate(expr('telemetry heartbeat'), other, NOW))).toBe(true);
  });

  it('session purge stalled: 1 when no ok run in 50 minutes, 0 (not firing) when one ran', () => {
    const stalled = [series('session_purge_runs_total', { status: 'ok' }, (t) => (t <= NOW - 3600 ? 3 : 3))];
    expect(evaluate(expr('session purge stalled'), stalled, NOW)).toEqual([{ labels: {}, value: 1 }]);
    const running = [series('session_purge_runs_total', { status: 'ok' }, (t) => (t <= NOW - 900 ? 3 : 4))];
    expect(fires(evaluate(expr('session purge stalled'), running, NOW))).toBe(false);
    // No series at all is the heartbeat's job: the empty sum is NoData, which noDataState OK keeps Normal.
    expect(evaluate(expr('session purge stalled'), [], NOW)).toEqual([]);
  });

  // GWP#116: each task writes its own series (`instance`, GWP#86), so the rule sums across tasks. In a
  // rolling deploy the new task starts an hour ago and the old one stops a minute later; the old task's
  // last run was 10 minutes before it stopped, and the new task's series is born at 1 by its startup purge.
  it('session purge stalled sums across tasks: quiet at every minute of a rolling deploy, fires when every task is flat for 50 minutes (#116)', () => {
    const started = NOW - 3660;
    const stopped = NOW - 3600;
    const deploy = [
      series('session_purge_runs_total', { status: 'ok', instance: 'old' }, (t) => (t <= stopped ? Math.floor((t - (NOW - 7800)) / 900) : undefined)),
      series('session_purge_runs_total', { status: 'ok', instance: 'new' }, (t) => (t >= started ? Math.floor((t - started) / 900) + 1 : undefined)),
    ];
    for (let at = started; at <= NOW; at += 60) {
      expect(fires(evaluate(expr('session purge stalled'), deploy, at)), `${at - started} s after the deploy`).toBe(false);
    }
    // Both tasks inside the window, neither finishing a run: two zeros sum to zero.
    const flat = [
      series('session_purge_runs_total', { status: 'ok', instance: 'old' }, (t) => (t <= NOW - 600 ? 4 : undefined)),
      series('session_purge_runs_total', { status: 'ok', instance: 'new' }, (t) => (t >= NOW - 1200 ? 1 : undefined)),
    ];
    expect(evaluate(expr('session purge stalled'), flat, NOW)).toEqual([{ labels: {}, value: 1 }]);
  });

  it('delivery failed: fires on a task\'s first failure when the series was primed at 0, and on a later one', () => {
    const primed = [series('distribution_deliveries_total', { kind: 'webhook', status: 'failed' }, (t) => (t > NOW - 600 ? 1 : 0))];
    expect(fires(evaluate(expr('delivery failed'), primed, NOW))).toBe(true);
    // Unprimed, the series is born at 1 and increase() sees no change: why the API primes it at bootstrap.
    const born = [series('distribution_deliveries_total', { kind: 'webhook', status: 'failed' }, (t) => (t > NOW - 600 ? 1 : undefined))];
    expect(evaluate(expr('delivery failed'), born, NOW)).toEqual([]);
    const quiet = [series('distribution_deliveries_total', { kind: 'webhook', status: 'failed' }, () => 0), series('distribution_deliveries_total', { kind: 'webhook', status: 'delivered' }, (t) => (t > NOW - 600 ? 9 : 0))];
    expect(fires(evaluate(expr('delivery failed'), quiet, NOW))).toBe(false);
  });

  // GWP#86: each task writes its own series (service.instance.id becomes the `instance` label). In a
  // rolling deploy the old task stops 30 minutes ago, a minute after the new one started.
  const STOPPED = NOW - 1800;
  const STARTED = NOW - 1860;
  const oldTask = (t: number) => t <= STOPPED;
  const newTask = (t: number) => t >= STARTED;

  it('delivery failed across a rolling deploy with per-task series: quiet for an old failure, fires on a new one', () => {
    // The old task's failure is days old: its series reads 1 throughout; the new task primes its own at 0.
    const deploy = [
      series('distribution_deliveries_total', { kind: 'webhook', status: 'failed', instance: 'old' }, (t) => (oldTask(t) ? 1 : undefined)),
      series('distribution_deliveries_total', { kind: 'webhook', status: 'failed', instance: 'new' }, (t) => (newTask(t) ? 0 : undefined)),
    ];
    expect(fires(evaluate(expr('delivery failed'), deploy, NOW))).toBe(false);
    const failure = [deploy[0]!, series('distribution_deliveries_total', { kind: 'webhook', status: 'failed', instance: 'new' }, (t) => (newTask(t) ? (t > NOW - 600 ? 1 : 0) : undefined))];
    expect(fires(evaluate(expr('delivery failed'), failure, NOW))).toBe(true);
  });

  it('delivery backlog: above 50 pending fires (Grafana then holds it 30 minutes), 50 does not', () => {
    expect(fires(evaluate(expr('delivery backlog'), [series('distribution_deliveries_pending', {}, () => 51)], NOW))).toBe(true);
    expect(fires(evaluate(expr('delivery backlog'), [series('distribution_deliveries_pending', {}, () => 50)], NOW))).toBe(false);
  });

  it('database unreachable: 1 when a check in the last 5 minutes recorded 0, 0 (not firing) when every check reached it', () => {
    const blip = [series('database_ready', {}, (t) => (t === NOW - 120 ? 0 : 1))];
    expect(evaluate(expr('database unreachable'), blip, NOW)).toEqual([{ labels: { deployment_environment: ENV }, value: 1 }]);
    const healthy = [series('database_ready', {}, () => 1)];
    expect(evaluate(expr('database unreachable'), healthy, NOW)).toEqual([{ labels: { deployment_environment: ENV }, value: 0 }]);
  });
});

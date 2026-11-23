import { describe, expect, it } from 'vitest';
import { burnRateRules, type BurnRateRule } from '../../observability/slo/definitions.js';
import { evaluate, type Series } from './promql-eval.js';

// Partition `unit`: the burn-rate rules' traffic floor (D-090, GWP#53), run through a small PromQL
// evaluator (tests/scripts/promql-eval.ts) over recorded counter samples. Below the floor a rule returns
// nothing whatever the ratio; above it the #7 thresholds apply unchanged.

const NOW = 100_000;
const ENV = 'getworkdone';
const EXPORT_INTERVAL = 15;

/**
 * http_server_requests_total for one /api/v1 route, sampled every 15 s for the last 7 hours: the series
 * exist (at 0) from earlier traffic, and `total` requests, `errors` of them 5xx, arrive in the last 4
 * minutes, inside every window of both rules.
 */
function traffic(total: number, errors: number, { synthetic = 0 }: { synthetic?: number } = {}): Series[] {
  const series = (statusClass: string, isSynthetic: boolean, count: number): Series => {
    const points: [number, number][] = [];
    for (let t = NOW - 7 * 3600; t <= NOW; t += EXPORT_INTERVAL) points.push([t, t > NOW - 240 ? count : 0]);
    return {
      labels: { __name__: 'http_server_requests_total', deployment_environment: ENV, synthetic: String(isSynthetic), route: '/api/v1/teams', method: 'GET', status_class: statusClass },
      points,
    };
  };
  return [series('2xx', false, total - errors), series('5xx', false, errors), series('2xx', true, synthetic)];
}

function rule(speed: 'fast' | 'slow'): BurnRateRule {
  return burnRateRules(ENV).find((r) => r.labels.slo === `${ENV}-api-availability` && r.speed === speed)!;
}

/** The rule's expression without its floor: #7's two-window threshold alone. */
function unguarded(r: BurnRateRule): string {
  return r.expr.slice(0, r.expr.indexOf(' and sum(increase('));
}

describe('the burn-rate traffic floor (D-090)', () => {
  it('fast availability: 19 requests, all 5xx, return nothing, though the threshold alone would fire', () => {
    const fast = rule('fast');
    expect(evaluate(fast.expr, traffic(19, 19), NOW)).toEqual([]);
    // The floor, not a missing series, is what keeps it quiet.
    expect(evaluate(unguarded(fast), traffic(19, 19), NOW)).toEqual([{ labels: {}, value: 1 }]);
  });

  it('fast availability: 20 requests with 2 5xx (0.1, above 0.072) fire', () => {
    const result = evaluate(rule('fast').expr, traffic(20, 2), NOW);
    expect(result).toHaveLength(1);
    expect(result[0]!.value).toBeCloseTo(0.1);
  });

  it('fast availability: 20 requests with 1 5xx (0.05) stay quiet: the threshold still applies above the floor', () => {
    expect(evaluate(rule('fast').expr, traffic(20, 1), NOW)).toEqual([]);
  });

  it('slow availability: 99 requests, all 5xx, stay quiet; 100 with 4 5xx (0.04, above 0.03) fire', () => {
    const slow = rule('slow');
    expect(evaluate(slow.expr, traffic(99, 99), NOW)).toEqual([]);
    expect(evaluate(unguarded(slow), traffic(99, 99), NOW)).toHaveLength(1);
    const result = evaluate(slow.expr, traffic(100, 4), NOW);
    expect(result).toHaveLength(1);
    expect(result[0]!.value).toBeCloseTo(0.04);
  });

  it('synthetic traffic never counts toward the floor', () => {
    // 19 real requests, all 5xx, plus 1,000 synthetic 2xx: still below the floor of real requests.
    expect(evaluate(rule('fast').expr, traffic(19, 19, { synthetic: 1000 }), NOW)).toEqual([]);
  });

  it('every burn rule parses and evaluates in the test evaluator', () => {
    for (const r of burnRateRules(ENV)) expect(() => evaluate(r.expr, traffic(50, 50), NOW), r.uid).not.toThrow();
  });
});

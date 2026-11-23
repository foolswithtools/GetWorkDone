import { describe, expect, it } from 'vitest';
import { LIVE_QUERIES, liveQuery } from '../live/queries.js';

const prometheus = LIVE_QUERIES.filter((q) => q.datasource === 'prometheus');
/** Prometheus live queries with no deployment_environment label: their series come from CloudWatch. */
const CLOUDWATCH = ['ecs-container-insights', 'alb-metrics'];

describe('live queries (GWP#9)', () => {
  it('every Prometheus live query matches deployment_environment exactly, never by regex', () => {
    expect(prometheus.length).toBeGreaterThan(0);
    for (const query of prometheus) {
      const matchers = [...query.query.matchAll(/deployment_environment\s*(=~|!~|!=|=)\s*"([^"]*)"/g)];
      if (CLOUDWATCH.includes(query.id)) {
        expect(matchers, query.id).toEqual([]);
        continue;
      }
      expect(matchers.length, query.id).toBeGreaterThan(0);
      for (const [, operator, value] of matchers) {
        expect(operator, query.id).toBe('=');
        expect(value, query.id).toBe('$environment');
      }
    }
  });

  it('the Container Insights query names the ECS service exactly', () => {
    expect(liveQuery('ecs-container-insights')?.query).toBe('count(aws_ecs_containerinsights_cpu_utilized_average{dimension_ServiceName="$service"})');
  });

  it('the ALB matcher is anchored at targetgroup/<name>/ followed by the hash', () => {
    const alb = liveQuery('alb-metrics');
    expect(alb?.datasource).toBe('prometheus');
    expect(alb?.query).toBe('count(aws_applicationelb_request_count_sum{dimension_TargetGroup=~"targetgroup/$target_group/[0-9a-f]+"})');
    // Prometheus anchors =~ at both ends, so a longer name that starts with this one never matches.
    const pattern = new RegExp(`^(?:${'targetgroup/getworkdone-dev/[0-9a-f]+'})$`);
    expect(pattern.test('targetgroup/getworkdone-dev/0123abcd')).toBe(true);
    expect(pattern.test('targetgroup/getworkdone-dev-other/0123abcd')).toBe(false);
  });

  it('every query has a non-empty failure message and a unique id', () => {
    for (const query of LIVE_QUERIES) expect(query.failure.trim(), query.id).not.toBe('');
    expect(new Set(LIVE_QUERIES.map((q) => q.id)).size).toBe(LIVE_QUERIES.length);
  });

  it('defines every live check the deploy verifies', () => {
    expect(LIVE_QUERIES.map((q) => [q.id, q.datasource])).toEqual([
      ['ecs-container-insights', 'prometheus'],
      ['alb-metrics', 'prometheus'],
      ['alloy-pipeline', 'prometheus'],
      ['k6-smoke', 'prometheus'],
      ['deployed-version', 'prometheus'],
      ['trace-end-to-end', 'tempo'],
      ['logs-trace-correlation', 'loki'],
      ['profiles', 'pyroscope'],
      ['oncall-routing', 'http'],
      ['burn-rate-alert-pages-oncall', 'oncall'],
      ['readyz', 'http'],
    ]);
    expect(liveQuery('deployed-version')?.query).toBe('count(target_info{deployment_environment="$environment",service_version="$version"})');
    expect(liveQuery('logs-trace-correlation')?.query).toBe('{service_name="getworkdone-api", deployment_environment="$environment"} | trace_id="$trace_id"');
    expect(liveQuery('trace-end-to-end')?.query).toBe('$trace_id');
    expect(liveQuery('nope')).toBeUndefined();
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HTTP_DURATION_BUCKETS } from '../../packages/telemetry/src/metrics.js';
import { ALERT_FOLDER_UID, CONTACT_POINT_NAME, contactPoints, isOwnedRoute, matchRoute, mergePolicy, notificationPolicy, ownedRoute, type Route } from '../alerting/definitions.js';
import { dashboards } from '../dashboards/definitions.js';
import { ENVIRONMENTS } from '../lib/environment.js';
import { DELIVERY_BACKLOG_THRESHOLD, signalRules, toSignalAlertRule } from '../signals/definitions.js';
import { BURN_RATES, burnRateRules, FAST_BURN_MIN_REQUESTS, LATENCY_THRESHOLD_SECONDS, SLOW_BURN_MIN_REQUESTS, sloDefinitions, toAlertRule, toGrafanaSlo } from '../slo/definitions.js';

const ONCALL_LINK = 'https://oncall.example.test/integrations/v1/grafana_alerting/abc/';

describe('SLO definitions', () => {
  it('defines API availability, API latency and capture availability, each 28 days', () => {
    const slos = sloDefinitions('getworkdone');
    expect(slos.map((s) => [s.id, s.objective, s.window])).toEqual([
      ['getworkdone-api-availability', 0.995, '28d'],
      ['getworkdone-api-latency', 0.95, '28d'],
      ['getworkdone-capture-availability', 0.995, '28d'],
    ]);
  });

  it('every SLO, including latency, has both a fast and a slow burn rule referencing it', () => {
    for (const environment of ENVIRONMENTS) {
      const rules = burnRateRules(environment);
      expect(rules).toHaveLength(6);
      for (const slo of sloDefinitions(environment)) {
        const own = rules.filter((r) => r.labels.slo === slo.id);
        expect(own.map((r) => r.speed).sort()).toEqual(['fast', 'slow']);
        for (const rule of own) {
          // The rule's expression is the SLO's own error ratio, over both of its windows.
          expect(rule.expr).toContain(slo.errorRatio(rule.longWindow));
          expect(rule.expr).toContain(slo.errorRatio(rule.shortWindow));
        }
      }
      expect(rules.filter((r) => r.labels.slo === `${environment}-api-latency`)).toHaveLength(2);
    }
  });

  it('every rule uid is unique and fits Grafana\'s 40-character uid limit', () => {
    const uids = ENVIRONMENTS.flatMap((e) => burnRateRules(e).map((r) => r.uid));
    expect(new Set(uids).size).toBe(12);
    for (const uid of uids) expect(uid).toMatch(/^[a-zA-Z0-9_-]{1,40}$/);
  });

  it('every rule carries a runbook_url to docs/runbooks/<slo short id>-burn.md in the private repo, and that file exists', () => {
    for (const environment of ENVIRONMENTS) {
      for (const rule of burnRateRules(environment)) {
        const shortId = rule.labels.slo!.slice(environment.length + 1);
        expect(rule.annotations.runbook_url).toBe(`https://github.com/foolswithtools/GetWorkDone-private/blob/main/docs/runbooks/${shortId}-burn.md`);
        expect(existsSync(new URL(`../../docs/runbooks/${shortId}-burn.md`, import.meta.url)), `docs/runbooks/${shortId}-burn.md`).toBe(true);
        expect(toAlertRule(rule, 'grafanacloud-prom').annotations.runbook_url).toBe(rule.annotations.runbook_url);
      }
    }
  });

  it('fast burn is 14.4x over 1 h and 5 m and pages; slow burn is 6x over 6 h and 30 m and warns', () => {
    expect(BURN_RATES).toEqual([
      { speed: 'fast', factor: 14.4, longWindow: '1h', shortWindow: '5m', severity: 'critical' },
      { speed: 'slow', factor: 6, longWindow: '6h', shortWindow: '30m', severity: 'warning' },
    ]);
    const rule = burnRateRules('getworkdone').find((r) => r.labels.slo === 'getworkdone-api-availability' && r.speed === 'fast')!;
    // 14.4 x (1 - 0.995) = 0.072 of the error budget's ratio, on both windows.
    expect(rule.expr.match(/> 0\.072\b/g)).toHaveLength(2);
    expect(rule.labels).toMatchObject({ severity: 'critical', team: 'getworkdone', deployment_environment: 'getworkdone' });
  });

  it('every selector excludes synthetic traffic and names its deployment.environment, so the two environments are separate', () => {
    for (const environment of ENVIRONMENTS) {
      for (const slo of sloDefinitions(environment)) {
        expect(slo.selector).toContain(`deployment_environment="${environment}"`);
        expect(slo.selector).toContain('synthetic="false"');
        expect(slo.successQuery).toContain(slo.selector);
        expect(slo.totalQuery).toContain(slo.selector);
      }
    }
    const prod = sloDefinitions('getworkdone').map((s) => s.successQuery);
    const dev = sloDefinitions('getworkdone-dev').map((s) => s.successQuery);
    expect(prod.filter((q) => dev.includes(q))).toEqual([]);
  });

  it('the latency threshold equals a histogram bucket boundary', () => {
    expect(LATENCY_THRESHOLD_SECONDS).toBe(0.8);
    expect(HTTP_DURATION_BUCKETS).toContain(LATENCY_THRESHOLD_SECONDS);
    const latency = sloDefinitions('getworkdone').find((s) => s.id === 'getworkdone-api-latency')!;
    expect(latency.successQuery).toContain(`http_server_request_duration_seconds_bucket{${latency.selector},le="0.8"}`);
    expect(latency.totalQuery).toContain(`http_server_request_duration_seconds_bucket{${latency.selector},le="+Inf"}`);
  });

  it('availability counts non-5xx over every /api/v1 route; capture availability selects the item-create route', () => {
    const [api, , capture] = sloDefinitions('getworkdone');
    expect(api!.selector).toContain('route=~"/api/v1/.*"');
    expect(api!.successQuery).toContain('status_class!="5xx"');
    // The route label is the Express route pattern the capture controller registers.
    const controller = readFileSync(new URL('../../apps/api/src/modules/capture/capture.controller.ts', import.meta.url), 'utf8');
    expect(controller).toContain("@Controller('api/v1/teams/:teamId/work-types/:workTypeId')");
    expect(controller).toContain("@Post('items')");
    expect(capture!.selector).toContain('route="/api/v1/teams/:teamId/work-types/:workTypeId/items"');
    expect(capture!.selector).toContain('method="POST"');
  });

  it('builds the Grafana SLO and alert-rule bodies from the definitions', () => {
    const slo = toGrafanaSlo(sloDefinitions('getworkdone')[1]!, 'grafanacloud-prom');
    expect(slo).toMatchObject({
      name: 'getworkdone-api-latency',
      objectives: [{ value: 0.95, window: '28d' }],
      query: { type: 'freeform', freeform: { query: expect.stringContaining('le="0.8"') } },
      destinationDatasource: { uid: 'grafanacloud-prom' },
    });
    // Sorted by key, so a read-back that sorts them still compares equal.
    expect(slo.labels.map((l) => l.key)).toEqual(['deployment_environment', 'team']);
    const rule = toAlertRule(burnRateRules('getworkdone')[0]!, 'grafanacloud-prom');
    expect(rule).toMatchObject({ folderUID: ALERT_FOLDER_UID, ruleGroup: 'getworkdone-slo-burn', condition: 'B', noDataState: 'OK' });
    expect(rule.data.map((d) => d.refId)).toEqual(['A', 'B']);
  });
});

describe('alerting definitions', () => {
  it('no contact point has type email; the only one is the OnCall integration', () => {
    const points = contactPoints(ONCALL_LINK);
    for (const point of points) expect(point.type).not.toBe('email');
    expect(points).toEqual([{ uid: CONTACT_POINT_NAME, name: CONTACT_POINT_NAME, type: 'oncall', settings: { url: ONCALL_LINK }, disableResolveMessage: false }]);
  });

  it('refuses a placeholder contact point URL', () => {
    expect(() => contactPoints('')).toThrow('OnCall integration');
    expect(() => contactPoints('mailto:alerts@example.invalid')).toThrow('OnCall integration');
  });

  it("every rule's labels reach the OnCall receiver through the notification policy tree", () => {
    const tree = notificationPolicy();
    const receivers = new Set(contactPoints(ONCALL_LINK).map((c) => c.name));
    for (const environment of ENVIRONMENTS) {
      for (const rule of burnRateRules(environment)) {
        const path = matchRoute(tree, { ...rule.labels, alertname: rule.title, grafana_folder: 'GetWorkDone' });
        // Matched by the team route itself, not by falling through to the root.
        expect(path.length).toBeGreaterThan(1);
        expect(path.at(-1)!.object_matchers).toEqual([['team', '=', 'getworkdone']]);
        expect(receivers.has(path.at(-1)!.receiver!)).toBe(true);
      }
    }
  });

  it('the policy tree sets no field Grafana leaves out when it reads the tree back (omitempty false)', () => {
    const falses: string[] = [];
    JSON.stringify(notificationPolicy(), (key, value: unknown) => {
      if (value === false) falses.push(key);
      return value;
    });
    expect(falses).toEqual([]);
  });

  it('matchRoute follows Alertmanager matching: an unmatched alert stays on the root', () => {
    const tree = notificationPolicy();
    expect(matchRoute(tree, { team: 'other' })).toHaveLength(1);
    expect(matchRoute({ receiver: 'r', routes: [{ object_matchers: [['a', '!=', 'x']], routes: [{ receiver: 'deep', object_matchers: [['b', '=~', 'y.*']] }] }] }, { b: 'yes' }).map((r) => r.receiver ?? '(inherit)'))
      .toEqual(['r', '(inherit)', 'deep']);
    expect(matchRoute({ receiver: 'r', routes: [{ receiver: 'n', object_matchers: [['b', '!~', 'y.*']] }] }, { b: 'yes' })).toHaveLength(1);
  });

  it('mergePolicy of an empty tree is notificationPolicy() bar the root group_by, and merging a merged tree changes nothing (GWP#171)', () => {
    expect(mergePolicy({})).toEqual({ tree: { receiver: CONTACT_POINT_NAME, routes: [ownedRoute()] } });
    expect(mergePolicy({ receiver: 'grafana-default-email', group_by: ['grafana_folder', 'alertname'] }).tree).toEqual(notificationPolicy());
    const shared: Route = { receiver: 'fleet-default', routes: [{ receiver: 'fleet-loup-ops', object_matchers: [['service', '=', 'loup']] }, { receiver: 'x', group_by: ['a'], object_matchers: [['team', '=', 'getworkdone']] }] };
    const once = mergePolicy(shared);
    expect(once.rootNote).toBe('receiver fleet-default is not the stack default, left as is');
    expect(mergePolicy(once.tree).tree).toEqual(once.tree);
    // A root already ours is not changed, and is reported only while other tenants' routes share the tree.
    expect(mergePolicy(notificationPolicy())).toEqual({ tree: notificationPolicy() });
    const ours = mergePolicy({ ...shared, receiver: CONTACT_POINT_NAME });
    expect(ours.tree.receiver).toBe(CONTACT_POINT_NAME);
    expect(ours.rootNote).toContain(`receiver ${CONTACT_POINT_NAME} is not the stack default, left as is`);
    expect(ours.rootNote).toContain("other tenants' alerts");
  });

  it('isOwnedRoute owns exactly the team=getworkdone route, with no other or legacy matcher', () => {
    expect(isOwnedRoute(ownedRoute())).toBe(true);
    expect(isOwnedRoute({ object_matchers: [['team', '=', 'getworkdone'], ['slo', '=', 'x']] })).toBe(false);
    expect(isOwnedRoute({ object_matchers: [['team', '!=', 'getworkdone']] })).toBe(false);
    expect(isOwnedRoute({ object_matchers: [['team', '=', 'other']] })).toBe(false);
    expect(isOwnedRoute({ object_matchers: [['owner', '=', 'getworkdone']] })).toBe(false);
    expect(isOwnedRoute({})).toBe(false);
    for (const legacy of [{ matchers: ['a=b'] }, { match: { a: 'b' } }, { match_re: { a: 'b.*' } }]) expect(isOwnedRoute({ ...ownedRoute(), ...legacy } as Route)).toBe(false);
  });
});

describe('dashboard definitions', () => {
  it('one RED and SLO dashboard per environment, every panel query scoped to that environment', () => {
    for (const environment of ENVIRONMENTS) {
      const [board, ...rest] = dashboards(environment);
      expect(rest).toEqual([]);
      expect(board!.uid).toBe(`${environment}-red`);
      const exprs = board!.panels.flatMap((p) => ('targets' in p ? p.targets.map((t) => t.expr) : []));
      expect(exprs.length).toBeGreaterThan(0);
      for (const expr of exprs) expect(expr).toContain(`deployment_environment="${environment}"`);
    }
  });
});

describe('burn-rate traffic floor (D-090)', () => {
  it('pins the floors: 20 requests in the fast rule\'s 5 m window, 100 in the slow rule\'s 6 h window', () => {
    // Pinned, so changing a floor is a deliberate edit of this test too.
    expect(FAST_BURN_MIN_REQUESTS).toBe(20);
    expect(SLOW_BURN_MIN_REQUESTS).toBe(100);
  });

  it("every fast rule ends in its SLO's own total over 5 m >= 20, every slow rule over 6 h >= 100, after #7's unchanged threshold clauses", () => {
    for (const environment of ENVIRONMENTS) {
      for (const slo of sloDefinitions(environment)) {
        for (const rule of burnRateRules(environment).filter((r) => r.labels.slo === slo.id)) {
          const guard = rule.speed === 'fast' ? ` and sum(increase(${slo.totalQuery}[5m])) >= 20` : ` and sum(increase(${slo.totalQuery}[6h])) >= 100`;
          expect(rule.expr.endsWith(guard), rule.uid).toBe(true);
          // What precedes the guard is #7's two-window threshold, unchanged.
          expect(rule.expr.slice(0, -guard.length)).toBe(`${slo.errorRatio(rule.longWindow)} > ${rule.threshold} and ${slo.errorRatio(rule.shortWindow)} > ${rule.threshold}`);
          // The SLO total keeps synthetic="false", so probe traffic never counts toward the floor.
          expect(guard).toContain('synthetic="false"');
        }
      }
    }
  });
});

describe('signal rules (<env>-signals)', () => {
  const RUNBOOK = 'https://github.com/foolswithtools/GetWorkDone-private/blob/main/docs/runbooks';

  it('the group has exactly the heartbeat, purge-stalled, delivery-failed, delivery-backlog and database-unreachable rules', () => {
    for (const environment of ENVIRONMENTS) {
      expect(signalRules(environment).map((r) => r.title)).toEqual([
        `${environment} telemetry heartbeat`,
        `${environment} session purge stalled`,
        `${environment} delivery failed`,
        `${environment} delivery backlog`,
        `${environment} database unreachable`,
      ]);
    }
  });

  it('each rule carries team, deployment_environment, severity and a runbook_url whose file exists', () => {
    for (const environment of ENVIRONMENTS) {
      for (const rule of signalRules(environment)) {
        expect(rule.labels).toMatchObject({ team: 'getworkdone', deployment_environment: environment });
        expect(['critical', 'warning']).toContain(rule.labels.severity);
        const url = rule.annotations.runbook_url ?? '';
        expect(url.startsWith(`${RUNBOOK}/`)).toBe(true);
        const file = url.slice(RUNBOOK.length + 1);
        expect(existsSync(new URL(`../../docs/runbooks/${file}`, import.meta.url)), file).toBe(true);
      }
    }
  });

  it('the heartbeat and database-unreachable rules page; purge stalled, delivery failed and delivery backlog warn', () => {
    const severities = Object.fromEntries(signalRules('getworkdone').map((r) => [r.title.slice('getworkdone '.length), r.labels.severity]));
    expect(severities).toEqual({
      'telemetry heartbeat': 'critical',
      'session purge stalled': 'warning',
      'delivery failed': 'warning',
      'delivery backlog': 'warning',
      'database unreachable': 'critical',
    });
  });

  it("the heartbeat's expression is absent_over_time over session_purge_runs_total with an exact deployment_environment", () => {
    for (const environment of ENVIRONMENTS) {
      const heartbeat = signalRules(environment).find((r) => r.title.endsWith('telemetry heartbeat'))!;
      expect(heartbeat.expr).toBe(`absent_over_time(session_purge_runs_total{deployment_environment="${environment}"}[10m])`);
    }
  });

  it('the delivery rules count failed deliveries over 1 h and hold the backlog above 50 for 30 minutes', () => {
    const rules = signalRules('getworkdone-dev');
    expect(rules.find((r) => r.title.endsWith('delivery failed'))!.expr).toBe('sum(increase(distribution_deliveries_total{deployment_environment="getworkdone-dev",status="failed"}[1h])) > 0');
    const backlog = rules.find((r) => r.title.endsWith('delivery backlog'))!;
    expect(DELIVERY_BACKLOG_THRESHOLD).toBe(50);
    expect(backlog.expr).toBe('max by (deployment_environment) (distribution_deliveries_pending{deployment_environment="getworkdone-dev"}) > 50');
    expect(backlog.for).toBe('30m');
    expect(rules.filter((r) => r !== backlog).every((r) => r.for === '0s')).toBe(true);
  });

  // Regression guard: every rule shares the `gt 0` evaluator, and a plain `== 0` keeps the sample's
  // value, 0, which `gt 0` never fires on. `== bool 0` turns a match into 1.
  it('purge stalled and database unreachable compare with == bool 0, never a bare == 0', () => {
    for (const environment of ENVIRONMENTS) {
      const rules = signalRules(environment);
      const stalled = rules.find((r) => r.title.endsWith('session purge stalled'))!;
      const database = rules.find((r) => r.title.endsWith('database unreachable'))!;
      expect(stalled.expr).toBe(`sum(increase(session_purge_runs_total{deployment_environment="${environment}",status="ok"}[50m])) == bool 0`);
      expect(database.expr).toBe(`min_over_time(database_ready{deployment_environment="${environment}"}[5m]) == bool 0`);
      for (const rule of rules) expect(rule.expr, rule.title).not.toMatch(/==\s*0\b/);
    }
  });

  it('every rule of both groups has noDataState OK and the gt 0 evaluator, in the shared folder', () => {
    for (const environment of ENVIRONMENTS) {
      const bodies = [
        ...burnRateRules(environment).map((r) => toAlertRule(r, 'grafanacloud-prom')),
        ...signalRules(environment).map((r) => toSignalAlertRule(r, 'grafanacloud-prom')),
      ];
      expect(bodies).toHaveLength(11);
      for (const body of bodies) {
        expect(body).toMatchObject({ folderUID: ALERT_FOLDER_UID, noDataState: 'OK', execErrState: 'Error', condition: 'B' });
        expect(body.data[1]!.model).toMatchObject({ type: 'threshold', expression: 'A', conditions: [{ evaluator: { type: 'gt', params: [0] } }] });
      }
      expect(new Set(bodies.map((b) => b.ruleGroup))).toEqual(new Set([`${environment}-slo-burn`, `${environment}-signals`]));
    }
  });

  it('group sizes stay under 20 rules, and rule uids are unique and fit 40 characters', () => {
    for (const environment of ENVIRONMENTS) {
      expect(burnRateRules(environment).length).toBeLessThan(20);
      expect(signalRules(environment)).toHaveLength(5);
    }
    const uids = ENVIRONMENTS.flatMap((e) => [...burnRateRules(e), ...signalRules(e)].map((r) => r.uid));
    expect(new Set(uids).size).toBe(22);
    for (const uid of uids) expect(uid).toMatch(/^[a-zA-Z0-9_-]{1,40}$/);
  });

  it("every signal rule's labels reach the OnCall receiver through the notification policy tree", () => {
    const tree = notificationPolicy();
    const receivers = new Set(contactPoints(ONCALL_LINK).map((c) => c.name));
    for (const environment of ENVIRONMENTS) {
      for (const rule of signalRules(environment)) {
        const path = matchRoute(tree, { ...rule.labels, alertname: rule.title, grafana_folder: 'GetWorkDone' });
        expect(path.length).toBeGreaterThan(1);
        expect(path.at(-1)!.object_matchers).toEqual([['team', '=', 'getworkdone']]);
        expect(receivers.has(path.at(-1)!.receiver!)).toBe(true);
      }
    }
  });
});

describe('dashboard delivery panels', () => {
  it('<env>-red shows deliveries per hour by kind and status, and the pending backlog with a line at 50, aggregated', () => {
    for (const environment of ENVIRONMENTS) {
      const panels = dashboards(environment)[0]!.panels;
      const data = panels.filter((p) => p.type !== 'row');
      const deliveries = data.find((p) => p.title === 'Deliveries per hour by kind and status')!;
      expect(deliveries.targets.map((t) => t.expr)).toEqual([`sum by (kind, status) (increase(distribution_deliveries_total{deployment_environment="${environment}"}[1h]))`]);
      const backlog = data.find((p) => p.title === 'Pending deliveries')!;
      expect(backlog.targets.map((t) => t.expr)).toEqual([`max by (deployment_environment) (distribution_deliveries_pending{deployment_environment="${environment}"})`]);
      expect(backlog.fieldConfig.defaults.thresholds?.steps.map((s) => s.value)).toEqual([null, 50]);
      // Free tier: never split by team or item.
      for (const panel of [deliveries, backlog]) for (const t of panel.targets) expect(t.expr).not.toMatch(/team|item/i);
      expect(new Set(panels.map((p) => p.id)).size).toBe(panels.length);
    }
  });
});

// GWP#58: one row per SLO after the six panels, with the SLI over 5 m, the burn rate over the slow and
// fast rules' long windows with both thresholds as lines, and the budget consumed over the dashboard's
// range, which the 14-day retention caps.
describe('dashboard SLO rows', () => {
  const board = (environment: (typeof ENVIRONMENTS)[number]) => dashboards(environment)[0]!;
  const dataPanels = (environment: (typeof ENVIRONMENTS)[number]) => board(environment).panels.flatMap((p) => (p.type === 'row' ? [] : [p]));
  const exprs = (panel: { targets: { expr: string }[] }) => panel.targets.map((t) => t.expr);

  it('keeps the six existing panels first, with their ids', () => {
    for (const environment of ENVIRONMENTS) {
      expect(board(environment).panels.slice(0, 6).map((p) => [p.id, p.type])).toEqual([1, 2, 3, 4, 5, 6].map((id) => [id, 'timeseries']));
    }
  });

  it('every SLO has a row, then an SLI panel, a 1 h and a 6 h burn-rate panel and a budget stat that reference its queries', () => {
    for (const environment of ENVIRONMENTS) {
      const panels = board(environment).panels.slice(6);
      const slos = sloDefinitions(environment);
      expect(panels).toHaveLength(slos.length * 5);
      slos.forEach((slo, index) => {
        const [row, sli, burn1h, burn6h, budget] = panels.slice(index * 5, index * 5 + 5);
        expect(row).toMatchObject({ type: 'row', title: slo.id, collapsed: false, panels: [] });
        expect(row!.gridPos).toMatchObject({ x: 0, w: 24, h: 1 });
        for (const panel of [sli, burn1h, burn6h, budget]) expect(panel!.type).not.toBe('row');
        const [s, b1, b6, bud] = [sli, burn1h, burn6h, budget] as Extract<typeof sli, { targets: unknown }>[];
        expect(s!.type).toBe('timeseries');
        expect(exprs(s!)).toEqual([`sum(rate(${slo.successQuery}[5m])) / sum(rate(${slo.totalQuery}[5m]))`]);
        const budgetRatio = Number((1 - slo.objective).toFixed(6));
        expect(b1!.type).toBe('timeseries');
        expect(exprs(b1!)).toEqual([`${slo.errorRatio('1h')} / ${budgetRatio}`]);
        expect(b6!.type).toBe('timeseries');
        expect(exprs(b6!)).toEqual([`${slo.errorRatio('6h')} / ${budgetRatio}`]);
        expect(bud!.type).toBe('stat');
        expect(exprs(bud!)).toEqual([`${slo.errorRatio('$__range')} / ${budgetRatio}`]);
        expect(bud!.targets[0]).toMatchObject({ instant: true });
        for (const panel of [s, b1, b6, bud]) {
          expect(exprs(panel!).join()).toContain(slo.successQuery);
          expect(exprs(panel!).join()).toContain(slo.totalQuery);
        }
        // The range caveat is explicit: the panel says it covers the dashboard's range, at most 14 days.
        expect(bud!.title).toContain('dashboard range');
        expect(bud!.title).toContain('14 days');
      });
    }
  });

  it("the burn-rate panels' threshold lines are BURN_RATES' factors", () => {
    const factors = BURN_RATES.map((r) => r.factor).sort((a, b) => a - b);
    for (const environment of ENVIRONMENTS) {
      const burns = dataPanels(environment).filter((p) => /burn rate over (1|6) h$/.test(p.title));
      expect(burns).toHaveLength(sloDefinitions(environment).length * 2);
      for (const panel of burns) {
        expect(panel.fieldConfig.defaults.custom).toEqual({ thresholdsStyle: { mode: 'line' } });
        expect(panel.fieldConfig.defaults.thresholds?.steps.map((step) => step.value)).toEqual([null, ...factors]);
      }
    }
  });

  it('panel ids are unique and stable, every SLO-row query carries the environment selector and synthetic="false"', () => {
    for (const environment of ENVIRONMENTS) {
      const ids = board(environment).panels.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual([1, 2, 3, 4, 5, 6, 10, 11, 12, 13, 14, 20, 21, 22, 23, 24, 30, 31, 32, 33, 34]);
      for (const panel of dataPanels(environment).filter((p) => p.id >= 10)) {
        for (const expr of exprs(panel)) {
          expect(expr).toContain(`deployment_environment="${environment}"`);
          expect(expr).toContain('synthetic="false"');
        }
      }
    }
  });

  it('panels do not overlap on the grid', () => {
    for (const environment of ENVIRONMENTS) {
      const cells = new Set<string>();
      for (const { gridPos: g, id } of board(environment).panels) {
        for (let x = g.x; x < g.x + g.w; x++) for (let y = g.y; y < g.y + g.h; y++) {
          expect(cells.has(`${x},${y}`), `panel ${id} at ${x},${y}`).toBe(false);
          cells.add(`${x},${y}`);
        }
        expect(g.x + g.w).toBeLessThanOrEqual(24);
      }
    }
  });
});

// GetWorkDone's SLOs and their burn-rate rules (GWP#7, D-027), modelled on the exemplar's
// observability/slo/definitions.ts @ 12a071e, which computed burn only from the 5xx ratio, so nothing
// watched its latency SLO (prebutton.md:347). Here every SLO, latency included, gets a fast and a slow
// burn-rate rule over its own error ratio.
//
// Selectors read the RED metrics of packages/telemetry/src/metrics.ts. Every selector names its
// deployment.environment, so getworkdone and getworkdone-dev are separate SLOs, and keeps
// synthetic="false", so k6 and other probes (a subject in SYNTHETIC_SUBJECTS, GWP#9) never spend the error budget.

import { ALERT_FOLDER_UID } from '../alerting/definitions.js';
import { ENVIRONMENT_LABEL, TEAM, uidPrefix, type Environment } from '../lib/environment.js';

export const SLO_WINDOW = '28d';

/** The latency SLO's threshold: a boundary of http_server_request_duration_seconds (HTTP_DURATION_BUCKETS). */
export const LATENCY_THRESHOLD_SECONDS = 0.8;

/** Every API route; the route label is the Express route pattern (apps/api/src/common/red.ts). */
const API_ROUTES = '/api/v1/.*';

/** The item-create route: POST on the capture controller's `items` (apps/api/src/modules/capture). */
export const CAPTURE_ROUTE = '/api/v1/teams/:teamId/work-types/:workTypeId/items';

export interface SloDefinition {
  id: string;
  environment: Environment;
  description: string;
  objective: number;
  window: typeof SLO_WINDOW;
  /** The label matchers every series of this SLO is selected with, without braces. */
  selector: string;
  /** The counter of good events, and of all events, as PromQL series selectors. */
  successQuery: string;
  totalQuery: string;
  /** The share of bad events over `window` (a PromQL range such as 1h). */
  errorRatio(window: string): string;
}

export interface BurnRate {
  speed: 'fast' | 'slow';
  factor: number;
  longWindow: string;
  shortWindow: string;
  severity: 'critical' | 'warning';
}

/**
 * Multiwindow burn rates (Google SRE workbook, as in the exemplar): fast spends 2 percent of a 30-day
 * budget in an hour and pages; slow spends 5 percent in six hours and warns. The short window stops the
 * alert soon after the burn does.
 */
export const BURN_RATES: readonly BurnRate[] = [
  { speed: 'fast', factor: 14.4, longWindow: '1h', shortWindow: '5m', severity: 'critical' },
  { speed: 'slow', factor: 6, longWindow: '6h', shortWindow: '30m', severity: 'warning' },
];

/**
 * The burn-rate rules' traffic floor (D-090): no alert while the window holds fewer real requests than
 * this, whatever the ratio, so one 500 among a dozen requests on a quiet instance pages nobody. The fast
 * floor counts the fast rule's 5-minute short window, the slow floor the slow rule's 6-hour long window.
 * Above the floor the thresholds apply unchanged.
 */
export const FAST_BURN_MIN_REQUESTS = 20;
export const SLOW_BURN_MIN_REQUESTS = 100;

const BURN_FLOORS: Record<BurnRate['speed'], { minRequests: number; window: string }> = {
  fast: { minRequests: FAST_BURN_MIN_REQUESTS, window: '5m' },
  slow: { minRequests: SLOW_BURN_MIN_REQUESTS, window: '6h' },
};

function slo(args: Omit<SloDefinition, 'window' | 'errorRatio'>): SloDefinition {
  return {
    ...args,
    window: SLO_WINDOW,
    errorRatio: (window) => `(1 - (sum(rate(${args.successQuery}[${window}])) / sum(rate(${args.totalQuery}[${window}]))))`,
  };
}

export function sloDefinitions(environment: Environment): SloDefinition[] {
  const base = `${ENVIRONMENT_LABEL}="${environment}",synthetic="false"`;
  const api = `${base},route=~"${API_ROUTES}"`;
  const capture = `${base},route="${CAPTURE_ROUTE}",method="POST"`;
  const bucket = 'http_server_request_duration_seconds_bucket';
  return [
    slo({
      id: `${environment}-api-availability`,
      environment,
      description: 'API availability: 99.5 percent of /api/v1 requests over 28 days end without a 5xx.',
      objective: 0.995,
      selector: api,
      successQuery: `http_server_requests_total{${api},status_class!="5xx"}`,
      totalQuery: `http_server_requests_total{${api}}`,
    }),
    slo({
      id: `${environment}-api-latency`,
      environment,
      description: `API latency: 95 percent of /api/v1 requests over 28 days finish within ${LATENCY_THRESHOLD_SECONDS} s.`,
      objective: 0.95,
      selector: api,
      successQuery: `${bucket}{${api},le="${LATENCY_THRESHOLD_SECONDS}"}`,
      totalQuery: `${bucket}{${api},le="+Inf"}`,
    }),
    slo({
      id: `${environment}-capture-availability`,
      environment,
      description: 'Capture availability: 99.5 percent of item creations over 28 days end without a 5xx.',
      objective: 0.995,
      selector: capture,
      successQuery: `http_server_requests_total{${capture},status_class!="5xx"}`,
      totalQuery: `http_server_requests_total{${capture}}`,
    }),
  ];
}

/**
 * Where each rule's runbook lives: the private repo's main, which on-call maintainers can open and
 * which is current; the public snapshot (GWP#11) carries docs/runbooks/ only as of its tag. One
 * runbook per SLO, for both burn speeds and both environments.
 */
export const RUNBOOK_BASE = 'https://github.com/foolswithtools/GetWorkDone-private/blob/main/docs/runbooks';

export interface BurnRateRule extends BurnRate {
  uid: string;
  title: string;
  environment: Environment;
  /** The rule fires while the error ratio exceeds factor x budget on both windows, above the traffic floor. */
  expr: string;
  threshold: number;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

export function burnRateRules(environment: Environment): BurnRateRule[] {
  return sloDefinitions(environment).flatMap((def) =>
    BURN_RATES.map((rate) => {
      // Rounded so 14.4 x 0.005 reads 0.072 in the expression, not 0.07200000000000001.
      const threshold = Number((rate.factor * (1 - def.objective)).toFixed(6));
      const shortId = def.id.slice(environment.length + 1);
      const floor = BURN_FLOORS[rate.speed];
      return {
        ...rate,
        uid: `${uidPrefix(environment)}-${shortId}-${rate.speed}`,
        title: `${def.id} ${rate.speed} burn`,
        environment,
        threshold,
        // The guard counts the SLO's own total, which keeps synthetic="false": probe traffic never lifts a
        // window over the floor. `and` keeps the left side's value, the ratio, for the `gt 0` evaluator.
        expr:
          `${def.errorRatio(rate.longWindow)} > ${threshold} and ${def.errorRatio(rate.shortWindow)} > ${threshold}` +
          ` and sum(increase(${def.totalQuery}[${floor.window}])) >= ${floor.minRequests}`,
        labels: { slo: def.id, severity: rate.severity, team: TEAM, [ENVIRONMENT_LABEL]: environment, burn: rate.speed },
        annotations: {
          summary: `${def.id} is burning its error budget ${rate.factor}x too fast`,
          description: `${def.description} The error ratio is above ${threshold} over both ${rate.longWindow} and ${rate.shortWindow}, with at least ${floor.minRequests} requests in ${floor.window}.`,
          runbook_url: `${RUNBOOK_BASE}/${shortId}-burn.md`,
        },
      };
    }),
  );
}

/** The Grafana SLO plugin's body for one SLO (`/api/plugins/grafana-slo-app/resources/v1/slo`). */
export function toGrafanaSlo(def: SloDefinition, datasourceUid: string) {
  return {
    name: def.id,
    description: def.description,
    query: {
      type: 'freeform',
      freeform: { query: `sum(rate(${def.successQuery}[$__rate_interval])) / sum(rate(${def.totalQuery}[$__rate_interval]))` },
    },
    objectives: [{ value: def.objective, window: def.window }],
    destinationDatasource: { uid: datasourceUid },
    // Sorted by key, so a read-back that sorts them still compares equal.
    labels: [
      { key: ENVIRONMENT_LABEL, value: def.environment },
      { key: 'team', value: TEAM },
    ],
  };
}

const RANGE_SECONDS: Record<string, number> = { '1h': 3600, '6h': 21600 };

/** What every GetWorkDone alert rule body is built from: the burn-rate rules and the signal rules. */
export interface AlertRuleSpec {
  uid: string;
  title: string;
  ruleGroup: string;
  expr: string;
  /** The query's relative time range, in seconds back from now. */
  rangeSeconds: number;
  for: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

/**
 * The alerting provisioning API's body for one rule (`/api/v1/provisioning/alert-rules`). Every rule
 * shares the condition: query A, instant, and threshold B firing while A is above 0. A comparison that
 * should fire on a match of 0 must therefore use `== bool 0`, which yields 1: a bare `== 0` keeps the
 * sample's value, 0, which `gt 0` never fires on.
 */
export function alertRuleBody(spec: AlertRuleSpec, datasourceUid: string) {
  return {
    uid: spec.uid,
    orgID: 1,
    title: spec.title,
    folderUID: ALERT_FOLDER_UID,
    ruleGroup: spec.ruleGroup,
    condition: 'B',
    data: [
      {
        refId: 'A',
        datasourceUid,
        relativeTimeRange: { from: spec.rangeSeconds, to: 0 },
        model: { refId: 'A', expr: spec.expr, instant: true },
      },
      {
        refId: 'B',
        datasourceUid: '__expr__',
        relativeTimeRange: { from: 0, to: 0 },
        model: { refId: 'B', type: 'threshold', expression: 'A', conditions: [{ evaluator: { type: 'gt', params: [0] } }] },
      },
    ],
    // No traffic is not a burn: the ratio has no samples and the rule stays quiet. Silence itself is the
    // `<env> telemetry heartbeat` signal rule's job (signals/definitions.ts), whose query returns 1 on absence.
    noDataState: 'OK',
    execErrState: 'Error',
    for: spec.for,
    isPaused: false,
    labels: spec.labels,
    annotations: spec.annotations,
  };
}

/** The provisioning body for one burn-rate rule, in the group `<env>-slo-burn`. */
export function toAlertRule(rule: BurnRateRule, datasourceUid: string) {
  return alertRuleBody(
    {
      uid: rule.uid,
      title: rule.title,
      ruleGroup: `${rule.environment}-slo-burn`,
      expr: rule.expr,
      rangeSeconds: RANGE_SECONDS[rule.longWindow] ?? 3600,
      // The two-window shape already debounces (D-090 keeps 0s).
      for: '0s',
      labels: rule.labels,
      annotations: rule.annotations,
    },
    datasourceUid,
  );
}

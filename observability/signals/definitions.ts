// GetWorkDone's signal rules (GWP#53): what the burn-rate rules cannot see. Each environment gets the
// group `<env>-signals` beside `<env>-slo-burn`, in the same folder, with the same `team`,
// `deployment_environment` and `runbook_url` conventions, so the policy tree routes them to OnCall and
// `severity: critical` pages.
//
//   telemetry heartbeat     no session_purge_runs_total series for 10 minutes: the API, its Alloy sidecar
//                           or the access-policy token is dead. The purge runs at startup and every 15
//                           minutes and the API exports every 15 s, so the series is pushed continuously
//                           whether or not anyone uses the app. absent_over_time returns an empty vector
//                           while the series is there, which Grafana reads as NoData, so noDataState OK
//                           keeps a healthy pipeline quiet; on absence it returns 1 and `gt 0` fires.
//   session purge stalled   the series is there but no task finished an ok run in 50 minutes (three
//                           missed runs). Each task writes its own series (`instance`, GWP#86), so the
//                           rule sums across them: a deploy's new series, born at 1, and the old task's
//                           stopped series never warn on their own (GWP#116).
//   delivery failed         a delivery ended `failed` in the last hour; final, so a person decides.
//   delivery backlog        more than 50 pending deliveries for 30 minutes: the worker is not draining.
//   database unreachable    the in-process readiness check (apps/api/src/modules/health/readiness.ts)
//                           recorded database_ready 0 in the last 5 minutes.
//
// Every rule shares the burn-rate rules' condition (`gt 0` on an instant query, slo/definitions.ts
// alertRuleBody), so comparisons that should fire on 0 use `== bool 0`.

import { ENVIRONMENT_LABEL, TEAM, uidPrefix, type Environment } from '../lib/environment.js';
import { alertRuleBody, RUNBOOK_BASE } from '../slo/definitions.js';

/** The pending deliveries the backlog rule and the dashboard's line stand at. */
export const DELIVERY_BACKLOG_THRESHOLD = 50;

export interface SignalRule {
  /** The short id: the uid's suffix and the `signal` label. */
  id: string;
  uid: string;
  title: string;
  environment: Environment;
  expr: string;
  rangeSeconds: number;
  for: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

interface SignalSpec {
  id: string;
  name: string;
  expr: string;
  rangeSeconds: number;
  for: string;
  severity: 'critical' | 'warning';
  /** A file under docs/runbooks/. */
  runbook: string;
  summary: string;
  description: string;
}

function specs(environment: Environment): SignalSpec[] {
  const env = `${ENVIRONMENT_LABEL}="${environment}"`;
  return [
    {
      id: 'telemetry-heartbeat',
      name: 'telemetry heartbeat',
      expr: `absent_over_time(session_purge_runs_total{${env}}[10m])`,
      rangeSeconds: 600,
      for: '0s',
      // A stack nobody can see is treated as burning.
      severity: 'critical',
      runbook: 'telemetry-heartbeat.md',
      summary: `${environment} has pushed no session_purge_runs_total for 10 minutes`,
      description: 'The API, its Alloy sidecar or the Grafana Cloud access-policy token is down: no metric from this environment has arrived for 10 minutes, so every other rule is blind.',
    },
    {
      id: 'session-purge-stalled',
      name: 'session purge stalled',
      expr: `sum(increase(session_purge_runs_total{${env},status="ok"}[50m])) == bool 0`,
      rangeSeconds: 3000,
      for: '0s',
      severity: 'warning',
      runbook: 'telemetry-heartbeat.md',
      summary: `${environment} has finished no session purge in 50 minutes`,
      description: 'Telemetry arrives, but no task has finished a run of the expired sign-in and session purge in 50 minutes (three missed runs): it fails or hangs.',
    },
    {
      id: 'delivery-failed',
      name: 'delivery failed',
      expr: `sum(increase(distribution_deliveries_total{${env},status="failed"}[1h])) > 0`,
      rangeSeconds: 3600,
      for: '0s',
      severity: 'warning',
      runbook: 'delivery-failed.md',
      summary: `${environment} ended a delivery failed in the last hour`,
      description: 'A webhook or email delivery ended failed, which is final: the item stays completed and the output was not delivered. A person decides whether to add the output again (docs/outputs.md).',
    },
    {
      id: 'delivery-backlog',
      name: 'delivery backlog',
      expr: `max by (${ENVIRONMENT_LABEL}) (distribution_deliveries_pending{${env}}) > ${DELIVERY_BACKLOG_THRESHOLD}`,
      rangeSeconds: 600,
      for: '30m',
      severity: 'warning',
      runbook: 'delivery-failed.md',
      summary: `${environment} has held more than ${DELIVERY_BACKLOG_THRESHOLD} pending deliveries for 30 minutes`,
      description: 'The delivery worker is not draining: a stuck lease, or a receiver that times out every attempt.',
    },
    {
      id: 'database-unreachable',
      name: 'database unreachable',
      expr: `min_over_time(database_ready{${env}}[5m]) == bool 0`,
      rangeSeconds: 300,
      for: '0s',
      severity: 'critical',
      runbook: 'database-unreachable.md',
      summary: `${environment} could not reach its database in the last 5 minutes`,
      description: "The API's in-process readiness check (SELECT 1, every 30 s, 2 s timeout) failed: requests that touch the database fail. The ALB health check stays /healthz, so tasks are not restarted for it.",
    },
  ];
}

export function signalRules(environment: Environment): SignalRule[] {
  return specs(environment).map((spec) => ({
    id: spec.id,
    uid: `${uidPrefix(environment)}-${spec.id}`,
    title: `${environment} ${spec.name}`,
    environment,
    expr: spec.expr,
    rangeSeconds: spec.rangeSeconds,
    for: spec.for,
    labels: { signal: spec.id, severity: spec.severity, team: TEAM, [ENVIRONMENT_LABEL]: environment },
    annotations: { summary: spec.summary, description: spec.description, runbook_url: `${RUNBOOK_BASE}/${spec.runbook}` },
  }));
}

/** The provisioning body for one signal rule, in the group `<env>-signals`. */
export function toSignalAlertRule(rule: SignalRule, datasourceUid: string) {
  return alertRuleBody(
    {
      uid: rule.uid,
      title: rule.title,
      ruleGroup: `${rule.environment}-signals`,
      expr: rule.expr,
      rangeSeconds: rule.rangeSeconds,
      for: rule.for,
      labels: rule.labels,
      annotations: rule.annotations,
    },
    datasourceUid,
  );
}

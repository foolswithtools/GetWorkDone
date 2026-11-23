// The GetWorkDone environments one Grafana Cloud stack watches (D-042). Each `apply.ts` run provisions
// one environment's SLOs, burn-rate rules and dashboard; the OnCall objects, contact point, folder and
// policy tree are shared and come out the same from either run.

export const ENVIRONMENTS = ['getworkdone', 'getworkdone-dev'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * The PromQL label carrying the OpenTelemetry resource attribute `deployment.environment`. Grafana Cloud
 * promotes that attribute to a label on OTLP metrics, with dots turned into underscores
 * (docs/observability.md, "Labels").
 */
export const ENVIRONMENT_LABEL = 'deployment_environment';

/** The `team` label every rule carries; the notification policy routes it to OnCall. */
export const TEAM = 'getworkdone';

export function isEnvironment(value: string): value is Environment {
  return (ENVIRONMENTS as readonly string[]).includes(value);
}

/** A short prefix for uids, which Grafana caps at 40 characters. */
export function uidPrefix(environment: Environment): string {
  return environment === 'getworkdone' ? 'gwd' : 'gwd-dev';
}

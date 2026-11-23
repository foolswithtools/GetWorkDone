// The live checks a coverage manifest entry may name (`check: { kind: live, query: <id> }`). In PR CI
// scripts/coverage-status.ts reports them `pending-live`; after each deploy scripts/verify-live.ts runs
// them against the stack (GWP#9) and scripts/coverage-check.ts --require-live enforces them.
//
// Placeholders in `query`, filled in by verify-live.ts from its arguments:
//   $environment   the deployment.environment checked (getworkdone or getworkdone-dev)
//   $service       the ECS service name, from the app stage's outputs
//   $target_group  the ALB target group NAME (the CloudWatch dimension is targetgroup/<name>/<hash>)
//   $version       the deployed git sha (service.version)
//   $trace_id      the trace id the k6 live smoke sent on GET /api/v1/me
//   $hostname      the instance's public host name (GWP#53's readyz check)
//
// Every Prometheus selector matches deployment_environment exactly (`=`): a regex would let the
// getworkdone check pass on getworkdone-dev series. The CloudWatch metrics carry no environment label;
// their selectors name the environment's own ECS service and target group instead. Grafana Cloud's
// CloudWatch scrape labels each dimension dimension_<Name> (read in Explore on 2026-10-30, #72), so the
// selectors use dimension_ServiceName and dimension_TargetGroup. A Prometheus check
// passes when its count() is above 0; the other datasources' rules are in scripts/verify-live.ts.

export type LiveDatasource = 'prometheus' | 'tempo' | 'loki' | 'pyroscope' | 'oncall' | 'http';

export interface LiveQuery {
  id: string;
  description: string;
  datasource: LiveDatasource;
  query: string;
  /** shown when the check fails; names the owner step or doc that fixes it */
  failure: string;
}

const AWS_INTEGRATION = "connect Grafana Cloud's AWS integration (docs/deploy/sandbox.md, 'CloudWatch metrics into Grafana Cloud')";

export const LIVE_QUERIES: readonly LiveQuery[] = [
  {
    id: 'ecs-container-insights',
    description: 'ECS Container Insights task metrics for the service reach the stack (GWP#8).',
    datasource: 'prometheus',
    query: 'count(aws_ecs_containerinsights_cpu_utilized_average{dimension_ServiceName="$service"})',
    failure: AWS_INTEGRATION,
  },
  {
    id: 'alb-metrics',
    description: 'ALB request, latency and 5xx metrics for the service reach the stack (GWP#8).',
    datasource: 'prometheus',
    query: 'count(aws_applicationelb_request_count_sum{dimension_TargetGroup=~"targetgroup/$target_group/[0-9a-f]+"})',
    failure: AWS_INTEGRATION,
  },
  {
    id: 'alloy-pipeline',
    description: 'The Alloy sidecar forwards OTLP metrics with the four resource attributes (GWP#8).',
    datasource: 'prometheus',
    // synthetic is on the API's RED metrics only, so request-4-change edge's series in the same
    // environment (GWP#10) cannot pass this for a broken API export.
    query: 'count(http_server_requests_total{deployment_environment="$environment",synthetic=~".+"})',
    failure: "the Alloy sidecar forwards nothing: check its Grafana Cloud token and endpoints (docs/deploy/sandbox.md, the Alloy token step) and the alloy container's log",
  },
  {
    id: 'k6-smoke',
    description: 'The k6 live smoke ran against the environment as synthetic traffic (GWP#9).',
    datasource: 'prometheus',
    query: 'count(http_server_requests_total{deployment_environment="$environment",synthetic="true"})',
    failure: "the live smoke did not run, or its user's sub is not in GETWORKDONE_SYNTHETIC_SUBJECTS (docs/deploy/sandbox.md, the k6 users)",
  },
  {
    id: 'deployed-version',
    description: 'The running API reports the deployed git sha as service.version (GWP#9).',
    datasource: 'prometheus',
    query: 'count(target_info{deployment_environment="$environment",service_version="$version"})',
    failure: 'no target_info series carries this version: the deployed task is not the one built, or service.version is not on target_info (docs/observability.md, "Labels the selectors need")',
  },
  {
    id: 'trace-end-to-end',
    description: "The API's server span for the smoke's GET /api/v1/me continues the traceparent k6 sent (GWP#9, D-089).",
    datasource: 'tempo',
    query: '$trace_id',
    failure: 'the API server span does not continue the traceparent the live smoke sent: check the Alloy traces pipeline and the propagator (docs/observability.md)',
  },
  {
    id: 'logs-trace-correlation',
    description: "The API's log records for the smoke's request reach Loki carrying its trace_id (GWP#9, D-044).",
    datasource: 'loki',
    query: '{service_name="getworkdone-api", deployment_environment="$environment"} | trace_id="$trace_id"',
    failure: 'no log line carries the trace id: check the Alloy logs pipeline and the Loki labels (verify-live.ts --probe-labels; docs/observability.md, "Labels the selectors need")',
  },
  {
    id: 'profiles',
    description: 'getworkdone-api pushes continuous profiles for the environment (GWP#9).',
    datasource: 'pyroscope',
    query: 'label values of service_name for {deployment_environment="$environment"}, last 15 minutes, include getworkdone-api',
    failure: "no profiles from getworkdone-api in the last 15 minutes: check the Alloy pyroscope receiver and the API's profiling setup (docs/observability.md)",
  },
  {
    id: 'oncall-routing',
    description: 'The OnCall integration exists and the team=getworkdone policy route points at the OnCall contact point, read back live (GWP#9).',
    datasource: 'http',
    query: 'OnCall integration getworkdone-alerting exists; /api/v1/provisioning/policies routes team=getworkdone to getworkdone-oncall',
    failure: 'run observability/apply.ts for this environment (docs/observability.md, "Running apply.ts")',
  },
  {
    id: 'burn-rate-alert-pages-oncall',
    description: 'A fault-injected burn fires the fast-burn rule and opens an OnCall alert group on the paging route (GWP#9).',
    datasource: 'oncall',
    query: 'drill result /getworkdone/dev/drill/last-result names an alert group for availability and latency',
    failure: 'run alert-drill.yml once (docs/runbooks/alert-drill.md)',
  },
  {
    id: 'readyz',
    description: "The deployed API's readiness: GET https://$hostname/readyz answers 200 with database ok (GWP#53).",
    datasource: 'http',
    query: 'GET https://$hostname/readyz answers 200 {"status":"ok","database":"ok"}',
    failure: 'the API cannot reach its database, or /readyz is not served: see docs/runbooks/database-unreachable.md',
  },
];

export function liveQuery(id: string): LiveQuery | undefined {
  return LIVE_QUERIES.find((q) => q.id === id);
}

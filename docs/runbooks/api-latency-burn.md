# Runbook: `<env>-api-latency` burn

The rules `<env>-api-latency fast burn` (critical, pages) and `<env>-api-latency slow burn` (warning, no page) fire when the share of `/api/v1` requests slower than 0.8 s is above 14.4 times (fast) or 6 times (slow) the budget of the 95 percent latency SLO, over both of the rule's windows (`observability/slo/definitions.ts`, [docs/observability.md](../observability.md)).

## Trigger

The OnCall alert group or Grafana rule `<env>-api-latency fast burn` (pages) or `<env>-api-latency slow burn` (no page), carrying the label `slo=<env>-api-latency` and this runbook as its `runbook_url`.

## What the rule measures

`1 - (bucket le="0.8" / bucket le="+Inf")` of `http_server_request_duration_seconds_bucket{deployment_environment="<env>",synthetic="false",route=~"/api/v1/.*"}`. 0.8 s is a boundary of the duration histogram; the request duration is timed from before routing to the final status.

## First checks

1. **Is it a drill?** In `getworkdone-dev`, a running `alert-drill.yml` run sets the `latency` fault on `GET /api/v1/__drill` (1.2 s per request); see [alert-drill.md](alert-drill.md).
2. **Which route is slow?** The dashboard `<env>-red`, panel "p95 duration", or in Explore (Prometheus):

   ```
   histogram_quantile(0.95, sum by (route, le) (rate(http_server_request_duration_seconds_bucket{deployment_environment="<env>",synthetic="false"}[5m])))
   ```
3. **Where is the time spent?** In Explore (Tempo), search for slow server spans of the API:

   ```
   { resource.service.name = "getworkdone-api" && resource.deployment.environment = "<env>" && span.kind = server && duration > 800ms }
   ```

   Database spans and outbound HTTP spans (`withSpan`) show which dependency is slow. Profiles (Pyroscope, `service_name="getworkdone-api"`) show CPU time.
4. **Is the task short of memory or CPU?** ECS Container Insights in Grafana (`aws_ecs_containerinsights_*` for the service): the task's 512 MiB is shared by the API and Alloy.
5. **Logs** for the slow trace: `{service_name="getworkdone-api", deployment_environment="<env>"} | trace_id="<trace id>"`.

## What to do

Roll back a bad deploy by promoting the previous digests, or relieve the slow dependency the traces name; a drill in dev needs nothing. The owner does any AWS change or promote (D-020).

## How to confirm

The "p95 duration" panel of `<env>-red` drops under the 0.8 s line, and the rule returns to Normal; then resolve the OnCall alert group.

## When to page a second person

If the fast burn is still firing 30 minutes after you acknowledged it, if the fix needs an AWS change by the owner, or if prod requests time out.

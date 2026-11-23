# Runbook: `<env>-api-availability` burn

The rules `<env>-api-availability fast burn` (critical, pages through OnCall) and `<env>-api-availability slow burn` (warning, opens an OnCall alert group and pages nobody) fire when the share of `/api/v1` requests that end in a 5xx is above 14.4 times (fast) or 6 times (slow) the error budget of the 99.5 percent SLO, over both of the rule's windows (`observability/slo/definitions.ts`, [docs/observability.md](../observability.md)). `<env>` is `getworkdone` (prod) or `getworkdone-dev`.

## Trigger

The OnCall alert group or Grafana rule `<env>-api-availability fast burn` (pages) or `<env>-api-availability slow burn` (no page), carrying the label `slo=<env>-api-availability` and this runbook as its `runbook_url`.

## What the rule measures

`1 - (non-5xx / all)` of `http_server_requests_total{deployment_environment="<env>",synthetic="false",route=~"/api/v1/.*"}`. Synthetic traffic (the k6 smoke's user, a subject in `SYNTHETIC_SUBJECTS`) is left out; the alert drill's user is not, on purpose ([alert-drill.md](alert-drill.md)).

## First checks

1. **Is it a drill?** In `getworkdone-dev`, look for a running `alert-drill.yml` run in Actions. If one is running, this alert is expected; see [alert-drill.md](alert-drill.md). A drill never runs against `getworkdone`.
2. **Which route?** Open the dashboard `<env>-red` (Grafana, Dashboards, folder GetWorkDone) and read the "5xx share" panel, or run in Explore (Prometheus):

   ```
   sum by (route, status_code) (rate(http_server_requests_total{deployment_environment="<env>",synthetic="false",status_class="5xx"}[5m]))
   ```
3. **What failed?** In Explore (Loki), the API's error lines for that route, with their trace ids:

   ```
   {service_name="getworkdone-api", deployment_environment="<env>"} | json | level="error"
   ```

   Open a line's `trace_id` in Tempo to see the failing span.
4. **Did a deploy just land?** Compare the start of the burn with the last `deploy.yml` run. A bad image is rolled back by promoting the previous digests, which the maintainers do (D-020).
5. **Is the database reachable?** Errors naming Prisma or the connection point at RDS; the maintainers' private deploy notes record a known residual on master-password rotation.

## What to do

Roll back a bad deploy by promoting the previous digests, or fix the failing dependency the logs name; a drill in dev needs nothing (it clears its own fault). The owner does any AWS change or promote (D-020).

## How to confirm

The "5xx share" panel of `<env>-red` drops back, and the rule returns to Normal in Grafana (Alerting, the rule `<env>-api-availability fast burn`); then resolve the OnCall alert group.

## When to page a second person

Page the other `prebutton-maintainers` member if the fast burn is still firing 30 minutes after you acknowledged it, if the cause is in AWS (RDS, ECS, ALB) and needs an owner apply, or if prod (`getworkdone`) is failing every request.

# Runbook: `<env>-capture-availability` burn

The rules `<env>-capture-availability fast burn` (critical, pages) and `<env>-capture-availability slow burn` (warning, no page) fire when the share of item creations (`POST /api/v1/teams/:teamId/work-types/:workTypeId/items`) that end in a 5xx is above 14.4 times (fast) or 6 times (slow) the budget of the 99.5 percent capture SLO ([docs/observability.md](../observability.md)).

## Trigger

The OnCall alert group or Grafana rule `<env>-capture-availability fast burn` (pages) or `<env>-capture-availability slow burn` (no page), carrying the label `slo=<env>-capture-availability` and this runbook as its `runbook_url`.

## What the rule measures

`1 - (non-5xx / all)` of `http_server_requests_total{deployment_environment="<env>",synthetic="false",route="/api/v1/teams/:teamId/work-types/:workTypeId/items",method="POST"}`. A 4xx (a capture that fails validation, a stale version) is not a burn. The alert drill does not touch this route.

## First checks

1. **What do the failures say?** In Explore (Loki):

   ```
   {service_name="getworkdone-api", deployment_environment="<env>"} | json | route="/api/v1/teams/:teamId/work-types/:workTypeId/items" | level="error"
   ```
2. **Is it one work type?** A definition that cannot be processed (an automated step, a transform) fails only that work type's captures; see [docs/capture.md](../capture.md) and [docs/process.md](../process.md).
3. **Is it the database?** Capture writes the item, its steps and its deliveries in one transaction; errors naming Prisma point at RDS.
4. **Did a deploy just land?** Compare with the last `deploy.yml` run; the maintainers roll back by promoting the previous digests.
5. The dashboard `<env>-red` shows the request rate and 5xx share for every route; the trace of a failing request (its `trace_id` in the log line) shows the failing span in Tempo.

## What to do

Fix or roll back what the failing captures name: a work type definition (its admin), a deploy (promote the previous digests, the owner) or the database (the owner, D-020).

## How to confirm

Item creations answer 201 again in the logs and the rule returns to Normal; then resolve the OnCall alert group.

## When to page a second person

If the fast burn is still firing 30 minutes after you acknowledged it, if users cannot capture at all in prod, or if the fix needs an owner apply.

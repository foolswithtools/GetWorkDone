# Runbook: `<env>` delivery failed and delivery backlog

Two signal rules of the group `<env>-signals` (`observability/signals/definitions.ts`, [docs/observability.md](../observability.md) "Signals", GWP#53) send you here. Both warn: they open an OnCall alert group and page nobody. `<env>` is `getworkdone` (prod) or `getworkdone-dev`.

- `<env> delivery failed`: `sum(increase(distribution_deliveries_total{deployment_environment="<env>",status="failed"}[1h])) > 0`. A webhook or email delivery ended `failed` in the last hour. A failed delivery is final: the item stays `completed` and the output was not delivered ([docs/outputs.md](../outputs.md) "Deliveries").
- `<env> delivery backlog`: `max by (deployment_environment) (distribution_deliveries_pending{deployment_environment="<env>"}) > 50` for 30 minutes. The worker is not draining: a stuck lease, or a receiver that times out every attempt.

## Trigger

The OnCall alert group or Grafana rule `<env> delivery failed` or `<env> delivery backlog`, carrying the label `signal=delivery-failed` or `signal=delivery-backlog` and this runbook as its `runbook_url`.

## First checks

1. **Which outputs?** The dashboard `<env>-red` (Grafana, Dashboards, folder GetWorkDone), panel "Deliveries per hour by kind and status", shows whether the failures are `webhook` or `email` and whether `retryable` attempts led up to them. The "Pending deliveries" panel shows the backlog with its line at 50.
2. **Why did they fail?** In Explore (Tempo), search spans named `distribute.deliver` with `delivery.status = failed`; each carries `delivery.reason`, `output.kind`, `output.id` and `item.id`. Or in Loki:

   ```
   {service_name="getworkdone-api", deployment_environment="<env>"} |= "delivery"
   ```

   Common reasons: the webhook receiver refuses connections or answers 4xx, the host resolves to a blocked address, SES refuses the message, or every attempt timed out.
3. **Backlog only?** If pending deliveries climb but nothing fails, the worker may be stuck behind leased rows or the team's delivery quota (`quota_deferred`, docs/outputs.md). Rows deferred by the quota stay pending until the window ends.

## What to do

- A failed delivery is not retried. Tell the team that owns the item (its work type's admins): they fix the receiver or the address and, if they still need the item delivered, remove the output and add it again (docs/outputs.md). Re-adding or retrying from the SPA is a later product change.
- A receiver down for every team, or SES refusing everything: fix the dependency (the owner does any AWS or SES change, D-020).
- A backlog with a stuck worker: check the API tasks are running and the database is reachable ([database-unreachable.md](database-unreachable.md)); a redeploy restarts the worker, and leased rows are claimed again when their lease lapses.

## How to confirm

No new `failed` points on the deliveries panel, and the rule returns to `Normal` in Grafana an hour after the last failure (its window is 1 hour). The backlog rule returns to `Normal` once the pending count is at or under 50. Resolve the OnCall alert group.

## When to page a second person

Page the other `prebutton-maintainers` member if the backlog keeps growing an hour after you acknowledged it, or if every delivery of a kind fails and the fix needs an AWS change.

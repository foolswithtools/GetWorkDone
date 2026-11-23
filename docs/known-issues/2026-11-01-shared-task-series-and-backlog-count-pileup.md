# Every API task wrote one metric series, and the backlog gauge piled up counts on a blackholed database

Resolved in GWP#86. Found by the fresh-context whole-branch review of #53 (2026-10-31); neither had been seen live.

**One series for every task.** Nothing set the OpenTelemetry resource attribute `service.instance.id`, and `prebutton.instance` is the environment's name (`deploy/sandbox/app/main.tf`), so every API task of an environment wrote the same metric series. With `desired_count = 1` two tasks overlap during every rolling deploy, and their cumulative counters then interleave on that series (for example N, 0, N, 0). Each drop reads as a counter reset, so `increase()` and `rate()` over-count during the overlap: the burn-rate ratios and the D-090 traffic floor skew, and since #53 primes `distribution_deliveries_total{status="failed"}` at 0 at bootstrap, a deploy could fire `<env> delivery failed` for a failure days old [inferred from the series identity].

Fix: `startOtel` (`packages/telemetry/src/otel.ts`) puts `service.instance.id` on the resource, one value per process: the ECS task id from the task metadata endpoint v4 (`ecsTaskId`, awaited by `apps/api/src/main.ts`, 1-second bound; only the task ARN's last segment, since the ARN names the account, D-035), else a random UUID. Grafana Cloud maps it to the `instance` label, so each task writes its own series (`docs/observability.md`, "Labels the selectors need"). The live probe that confirms the label has not run yet.

Consequence not fixed here: `<env> session purge stalled` does not sum across tasks, so with per-task series it warns after each deploy, for the new task's first 15 minutes and again for the old task's series about 35 to 50 minutes after it stopped. Changing a rule's expression was outside #86; #116 sums it (fixed, [2026-11-01-purge-stalled-per-task-series.md](2026-11-01-purge-stalled-per-task-series.md)).

**Backlog counts piling up.** `DeliveryBacklog.pending()` (`apps/api/src/modules/distribute/delivery.backlog.ts`) started a new `COUNT` on every 15-second export, even while the previous one was still outstanding, so a blackholed database filled the pg pool one connection per export. The readiness check already reused its outstanding `SELECT 1`. Fix: `pending()` returns the count in flight while there is one, as `Readiness` does.

Why no test caught them: the telemetry tests start one process, and nothing held a count outstanding across two exports.

Regression tests:

- `packages/telemetry/src/otel.test.ts` (unit), "an exported metric carries a service.instance.id, distinct between two started resources, beside the four required attributes", with the `ecsTaskId` cases beside it (task id read, no request outside ECS, every failure and the timeout undefined).
- `tests/scripts/signal-rules.test.ts` (unit), "delivery failed across a rolling deploy with per-task series: quiet for an old failure, fires on a new one", and the purge-stalled case that records #116's gap.
- `apps/api/test/delivery-backlog.integration.test.ts` (integration), "while one count is outstanding, a second export starts no second query": an exclusive lock on `Delivery` holds the first count, and `pg_stat_activity` shows one waiting `COUNT` after the second export, not two.

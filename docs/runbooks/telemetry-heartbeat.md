# Runbook: `<env>` telemetry heartbeat and session purge stalled

Two signal rules of the group `<env>-signals` (`observability/signals/definitions.ts`, [docs/observability.md](../observability.md) "Signals", GWP#53) send you here. `<env>` is `getworkdone` (prod) or `getworkdone-dev`.

- `<env> telemetry heartbeat` (critical, pages through OnCall): `absent_over_time(session_purge_runs_total{deployment_environment="<env>"}[10m])`. The API runs the session purge at startup and every 15 minutes and exports its metrics every 15 seconds, so the series arrives continuously whether or not anyone uses the app. When it has been absent for 10 minutes, nothing from the environment is reaching Grafana Cloud, and every other rule of the environment is blind. The rule pages because a stack nobody can see is treated as burning.
- `<env> session purge stalled` (warning, opens an OnCall alert group and pages nobody): `sum(increase(session_purge_runs_total{deployment_environment="<env>",status="ok"}[50m])) == bool 0`. Telemetry arrives, but no task has finished a purge run `ok` in 50 minutes (three missed runs). It sums across tasks (GWP#116), so a rolling deploy does not fire it.

## Trigger

The OnCall alert group or Grafana rule `<env> telemetry heartbeat` or `<env> session purge stalled`, carrying the labels `signal=telemetry-heartbeat` or `signal=session-purge-stalled` and this runbook as its `runbook_url`.

## First checks

1. **Was the environment destroyed on purpose?** A destroyed `getworkdone-dev` (`destroy.yml`, run by the maintainers) pushes nothing. It no longer pages: after the app stage's destroy, `destroy.yml` pauses every `getworkdone-dev` rule (GWP#85), and the next deploy unpauses them. If it pages anyway after a `destroy.yml` run, the pause failed (the run's `app-dev-destroy` job warns `The getworkdone-dev alert rules may not be paused`) or the destroy took more than 10 minutes after the service stopped: add a silence in Grafana (Alerting, Silences) matching `deployment_environment=getworkdone-dev` until `dev` is deployed again (the maintainers' deploy notes, which are private, describe it) and resolve the alert group; nothing is broken.
2. **Just deployed for the first time, or recreated?** `session purge stalled` can warn once for about 15 minutes after a new environment's first deploy: its first `ok` run creates the only series at 1, so the 50-minute `increase()` reads 0 until the second run. An ordinary redeploy of a running environment does not do this (the old task's runs keep the sum above 0). It clears by itself at the next run; nothing to do.
3. **Heartbeat or purge?** If only `session purge stalled` fires, telemetry works and the purge is the problem: go to step 7. If `telemetry heartbeat` fires, the pipeline is down: continue.
4. **Is the API running?** In the AWS console (ECS, the environment's service), check the running task count and the last events. A task stuck in a restart loop or a service scaled to 0 stops every metric. `curl -s https://<hostname>/healthz` answers `{"status":"ok"}` while an API task is up.
5. **Is the Alloy sidecar running?** In the task, the `alloy` container must be `RUNNING`. Its log (CloudWatch Logs, the task's log group) names export errors. The API's own lines in that log group are `warn` and above plus its `listening` and `quotas` lines (GWP#58, GWP#134): its `info` lines go only to Loki, through this sidecar. To see them in CloudWatch while the pipeline is down, set the environment's GitHub variable `GETWORKDONE_LOG_STDOUT_LEVEL` to `info` and redeploy, which sets `LOG_STDOUT_LEVEL=info` on the API container; delete it and redeploy afterwards ([observability.md](../observability.md) "Logs").
6. **Is the access-policy token valid?** A `401` or `403` in the Alloy log from the Grafana Cloud endpoints means the token in the instance's Grafana Cloud token secret (which the owner puts, from the maintainers' private deploy notes) is wrong, expired or revoked.
7. **Is the purge failing?** In Explore (Loki):

   ```
   {service_name="getworkdone-api", deployment_environment="<env>"} |= "session purge"
   ```

   A `session purge failed` line names the error. A `session purge waiting for the database schema` line with no `session purge started` after it means the purge never started (GWP#101): the API's role cannot log in yet (`28P01` in its `err`) or the schema is missing, so the migrate task did not run or failed; see the maintainers' private deploy notes on migrations. Usually it is the database; check the `<env> database unreachable` rule and [database-unreachable.md](database-unreachable.md). `session_purge_runs_total{status="error"}` counts failed runs.

## What to do

- API not running: read the ECS service events and the API container's log for the reason, and roll back a bad deploy by promoting the previous digests. The owner does any AWS change or promote (D-020).
- Sidecar not running or token refused: the owner puts a valid access-policy token in the secret and forces a new deployment of the service.
- Purge failing: fix the cause its log line names (most often the database).

## How to confirm

`session_purge_runs_total{deployment_environment="<env>"}` has fresh samples in Explore, and the rule returns to `Normal` in Grafana within about 15 minutes; then resolve the OnCall alert group. While the pipeline is healthy the heartbeat reads `Normal`, not `NoData`: its query is empty while the series is present, and `noDataState: OK` keeps it quiet.

## When to page a second person

Page the other `prebutton-maintainers` member if the heartbeat is still firing 30 minutes after you acknowledged it, or if the fix needs an AWS change and the owner is not reachable.

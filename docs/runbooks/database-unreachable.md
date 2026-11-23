# Runbook: `<env>` database unreachable

The signal rule `<env> database unreachable` of the group `<env>-signals` (`observability/signals/definitions.ts`, [docs/observability.md](../observability.md) "Signals", GWP#53) is critical and pages through OnCall. `<env>` is `getworkdone` (prod) or `getworkdone-dev`.

Each API task runs a readiness check every 30 seconds (`apps/api/src/modules/health/readiness.ts`): `SELECT 1` through the shared Prisma client with a 2-second timeout, recorded as the gauge `database_ready` (1 or 0). The rule is `min_over_time(database_ready{deployment_environment="<env>"}[5m]) == bool 0`: it fires when any task recorded a failed check in the last 5 minutes. `GET /readyz` serves the same check.

The ALB and ECS health check stays `GET /healthz`, which checks nothing: a database outage must not make the ALB kill every task, which would turn one dependency's outage into a restart loop. So while this rule fires the tasks keep running and answer requests that do not touch the database.

## Trigger

The OnCall alert group or Grafana rule `<env> database unreachable`, carrying the label `signal=database-unreachable` and this runbook as its `runbook_url`.

## First checks

1. **Is it still down?** `curl -s https://<hostname>/readyz` prints `{"status":"ok","database":"ok"}` (200) when the database answers, `{"status":"degraded","database":"down"}` (503) when it does not. The answer is at most 30 seconds old.
2. **Is RDS up?** In the AWS console (RDS, the instance's database), check its status and recent events: a reboot, a failover, maintenance or storage full.
3. **Is it the password?** Errors in the API's log naming authentication (`28P01`). Since #57 the API connects as `getworkdone_app` with `getworkdone/<instance>/db-app`, which does not rotate: a refusal means the secret and the role disagree (a new password put but no migrate run since, or the role missing), and the pool re-reads the secret once (#66). The migrate task sets the role's password from the secret on every run (the maintainers' deploy notes, private, "Migrations"). A certificate error instead (`unable to verify the first certificate`, `altnames`) means the server's certificate does not chain to `deploy/rds/global-bundle.pem` or names another host (#57). In Loki:

   ```
   {service_name="getworkdone-api", deployment_environment="<env>"} |= "database"
   ```
4. **Is it the network?** A security group or subnet change made by an apply: compare the start of the alert with the last `deploy.yml` run.
5. **How bad?** The `<env>-api-availability` burn rules and the "5xx share" panel of `<env>-red` show what users see.

## What to do

The owner does any RDS or AWS change (D-020): wait out or fix the RDS event, restore the security group, or roll back the apply that broke the path. Nothing in the app needs restarting: the next check after the database answers records 1.

## How to confirm

`/readyz` answers 200 with `database: 'ok'`, and the rule returns to `Normal` in Grafana 5 minutes after the last failed check (its window is 5 minutes). Resolve the OnCall alert group.

## When to page a second person

Page the other `prebutton-maintainers` member if the database is still unreachable 30 minutes after you acknowledged it, or if prod (`getworkdone`) is down and the owner is not reachable.

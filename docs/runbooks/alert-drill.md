# Runbook: the alert drill

`.github/workflows/alert-drill.yml` proves, on `getworkdone-dev`, that the fast-burn rules of the API availability and latency SLOs fire and page through OnCall (GWP#9). It is the evidence for the coverage manifest's `alert-fault-injection` feature (live check `burn-rate-alert-pages-oncall`) in **both** environments: the rules are the same code for `getworkdone-dev` and `getworkdone`, the OnCall integration is shared, and prod has no fault route. Until one drill has passed, every deploy's `Live coverage` step fails naming `burn-rate-alert-pages-oncall`.

## Trigger

A deploy's `Live coverage` step fails with `burn-rate-alert-pages-oncall` pending ("run alert-drill.yml once", or "the last drill is stale: run alert-drill.yml again" once a result is 30 days old or dev was recreated, GWP#72), or a change to the SLO rules, the contact point or OnCall routing needs proving again.

## First checks (the owner, before the first drill)

- The dev `drill` user exists in the dev Cognito pool with a permanent password, its `sub` is in the `getworkdone-dev` environment variable `GETWORKDONE_FAULT_ADMIN_SUBJECTS` and **not** in `GETWORKDONE_SYNTHETIC_SUBJECTS`, and its credentials are in `getworkdone/deploy/k6-credentials` under `.dev.drill`. The owner sets these up from the maintainers' private deploy notes.
- `getworkdone/deploy/grafana-stack-token` holds the stack service-account token (role Admin), and the `getworkdone-dev` environment has `GRAFANA_URL` and `GRAFANA_ONCALL_URL`.
- A `deploy.yml` run has applied the app stage with those variables, so the dev task has `FAULT_INJECTION_ENABLED=true` and `FAULT_ADMIN_SUBJECTS`, and observability is applied (the rules and the OnCall integration exist).

## What to do

The owner or a maintainer dispatches the drill:

Actions, `alert-drill`, "Run workflow", branch `main`. A run from any other ref stops at its first step. One drill runs at a time (concurrency group `alert-drill-<repo>`). Do not push to `main` during a drill: the dev deploy restarts the task, which clears the fault, and the drill then times out; re-dispatch it.

## What it does

`tests/k6/fault-drill.js`, signed in as the `drill` user through the hosted UI, runs two phases, `latency` and then `errors`. Latency goes first: its fast-burn threshold is 0.72 of requests slower than 0.8 s over both windows, and an earlier errors phase's fast requests would dilute the 1-hour window below it; the availability threshold, 0.072, barely notices the latency phase's slow 200s.

1. `POST /api/v1/__fault` `{ mode, count: 5000 }`: `errors` makes the next drill requests answer 500, `latency` makes each wait 1.2 s (above the 0.8 s SLO boundary).
2. 300 `GET /api/v1/__drill` requests over five minutes, which clears the burn-rate traffic floor (D-090: 20 requests in the 5-minute window, 100 in the 6-hour one), then 15 more every 15 seconds while it waits.
3. Polls Grafana's rules API until `getworkdone-dev-api-availability fast burn` (or `getworkdone-dev-api-latency fast burn`) is `Firing` (15 minutes at most).
4. Polls OnCall's `alert_groups` for the `getworkdone-alerting` integration until a firing group with that alert name exists (5 minutes at most), records its id and resolves it.
5. Sets the fault `off` and waits until the rule is `Normal` again (10 minutes at most).

`teardown` sets the fault `off` whatever happened. The job then writes the SSM parameter `/getworkdone/dev/drill/last-result` (JSON: `runId`, `date`, and `alertGroups` with the `availability` and `latency` group ids) and prints it in the job summary.

## How to confirm

A result is evidence for 30 days, and only about the stack it drilled (GWP#72): `verify-live.ts` leaves `burn-rate-alert-pages-oncall` `pending-live` with "the last drill is stale: run alert-drill.yml again" once the `date` is more than 30 days old, or on dev once it is older than the ECS service (a `destroy.yml` and a new deploy). `destroy.yml` deletes `/getworkdone/dev/drill/last-result` with the dev app stage, so a recreated dev, and prod, drill again rather than pass on a stack that no longer exists. The drill stays a manual dispatch (it pages on-call; the owner decided against a schedule on 2026-11-03): the maintainer reruns it in the last week before the current result turns 30 days old. Next due: before 2026-12-22, for the result of 2026-11-22 (run 45062381614).

The run is green, its job summary shows the JSON it wrote to `/getworkdone/dev/drill/last-result`, and the next deploy's `Live coverage` step passes `burn-rate-alert-pages-oncall`. What a passing log shows:

The `Drill log` step prints, in order:

```
drill: latency: setting the fault
drill: latency: sent 300 drill requests in 360 s; waiting for "getworkdone-dev-api-latency fast burn" to fire
drill: getworkdone-dev-api-latency fast burn: Firing
drill: getworkdone-dev-api-latency fast burn: OnCall alert group <id>
drill: latency: fault off; waiting for "getworkdone-dev-api-latency fast burn" to be Normal
drill: getworkdone-dev-api-latency fast burn: Normal
drill: errors: setting the fault
...
drill: getworkdone-dev-api-availability fast burn: Normal
drill-result: {"alertGroups":{"latency":"<id>","availability":"<id>"}}
drill: teardown: fault off (200)
```

The fast-burn alert pages the `prebutton-maintainers` OnCall team, by design: expect a page for each phase while the drill runs.

## A stuck fault

A fault lapses by itself 60 minutes after it was set, and a new task (any deploy of dev) starts with none. To clear it at once, sign in to dev as the `drill` user and, with the CSRF token from `GET /api/v1/me`:

```
curl -s -X POST https://<dev hostname>/api/v1/__fault \
  -H 'content-type: application/json' -H "x-gwd-csrf: <csrfToken>" \
  -H 'cookie: __Host-gwd_session=<session cookie>' -d '{"mode":"off"}'
```

It answers `{ "mode": "off" }`. Then resolve any alert group the drill left open in OnCall (IRM, Alert groups, integration `getworkdone-alerting`).

## When the drill fails

- **Timed out waiting for Firing.** Check that the drill requests are counted: in Explore, `sum(rate(http_server_requests_total{deployment_environment="getworkdone-dev",route="/api/v1/__drill",synthetic="false"}[5m]))`. If they show `synthetic="true"`, the drill user's `sub` is in `GETWORKDONE_SYNTHETIC_SUBJECTS`; take it out and redeploy. If nothing shows, the Alloy pipeline is down (the deploy's `alloy-pipeline` check says the same).
- **No OnCall alert group.** If the `Drill log` shows `OnCall alert_groups answered <status>: ...`, OnCall refused the drill's lookup: the status and body say why (the first drill's `state=firing` filter was refused, #81). Otherwise the contact point or the policy route is wrong: the deploy's `oncall-routing` check reads both back. Either way, look in IRM, Alert groups, integration `getworkdone-alerting`: a group there means the page went out and only the lookup failed; resolve it by hand.
- **403 on `/api/v1/__fault`.** The drill user's `sub` is not in `GETWORKDONE_FAULT_ADMIN_SUBJECTS`, or the deploy that set it has not run. A 404 means the task has no `FAULT_INJECTION_ENABLED`.

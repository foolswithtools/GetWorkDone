# Observability as code: SLOs, burn-rate alerts, signals, OnCall and coverage status

GetWorkDone's Grafana Cloud configuration lives in code (GWP#7, D-027): SLOs, burn-rate rules, the OnCall team, escalation chain and integration, the contact point and notification policy tree, and a dashboard, all in the `observability/` workspace package, applied by `observability/apply.ts`. The stack is a new free-tier Grafana Cloud stack the owner supplies (D-042). GWP#7 wrote the definitions and the apply tooling; GWP#9 applies them live after every deploy, verifies them (below) and proves the alerts by fault injection. Decisions are cited by number from the program register (spec §9.4) and never copied here.

## Layout

| Path | What |
|---|---|
| `observability/slo/` | `definitions.ts`: the SLOs and their burn-rate rules; `apply.ts`: SLO app objects and alert rules |
| `observability/signals/` | `definitions.ts`: the signal rules of `<env>-signals` (GWP#53); `apply.ts` |
| `observability/alerting/` | `definitions.ts`: folder, contact point, policy tree and `matchRoute`; `apply.ts` |
| `observability/oncall/` | `definitions.ts`: team, escalation chain, integration, routes; `apply.ts` |
| `observability/dashboards/` | `definitions.ts`: one RED and SLO dashboard per environment; `apply.ts` |
| `observability/lib/` | `grafana-client.ts` (JSON client), `reconcile.ts` (create or update, then read back), environments and the datasource |
| `observability/live/queries.ts` | The live checks a coverage manifest entry can name (below) |
| `observability/apply.ts` | The entry point |

## SLOs

Each environment has its own three SLOs (`<env>` is `getworkdone` or `getworkdone-dev`). All are 28-day windows over the RED metrics of `packages/telemetry/src/metrics.ts`.

| SLO | Objective | Good events | All events |
|---|---|---|---|
| `<env>-api-availability` | 99.5 percent | `http_server_requests_total` with `status_class!="5xx"` | `http_server_requests_total` on every `/api/v1` route |
| `<env>-api-latency` | 95 percent | `http_server_request_duration_seconds_bucket{le="0.8"}` | the same histogram's `le="+Inf"` bucket |
| `<env>-capture-availability` | 99.5 percent | non-5xx `POST /api/v1/teams/:teamId/work-types/:workTypeId/items` | that route's requests |

Every selector has `deployment_environment="<env>"`, so the two environments never share an SLO, and `synthetic="false"`, so probe traffic (a subject in `SYNTHETIC_SUBJECTS`) never spends the error budget. 0.8 s is a boundary of the duration histogram (`HTTP_DURATION_BUCKETS`); `observability/test/definitions.test.ts` fails if it stops being one.

### Labels the selectors need

- **`deployment_environment`.** The API sets the OpenTelemetry resource attribute `deployment.environment` (`GETWORKDONE_ENVIRONMENT`). Grafana Cloud's OTLP ingestion promotes that attribute to the label `deployment_environment` on metrics by default ([OTLP format considerations](https://grafana.com/docs/grafana-cloud/send-data/otlp/otlp-format-considerations/)). If the Alloy sidecar (GWP#8) stops it being promoted, every SLO, rule and panel goes empty. The label name is one constant, `ENVIRONMENT_LABEL` in `observability/lib/environment.ts`.
- **`synthetic`.** Every RED data point carries `synthetic="true"` or `synthetic="false"`. A request is synthetic when it carries a verified identity (the deny-by-default guard sets it before any route) whose subject is in `SYNTHETIC_SUBJECTS`, a comma-separated list of OIDC subjects read at startup (`isSynthetic` in `apps/api/src/common/red.ts`, `subjectsFromEnv` in `apps/api/src/common/subjects.ts`, GWP#9). No header can make a request synthetic, and an anonymous request never is, so no client can keep its 5xx out of the SLOs. In CI the list is the k6 smoke's mock user, `k6-ci`; in a deployed instance it is the `sub` of the instance's `synthetic` Cognito user, from the GitHub environment variable `GETWORKDONE_SYNTHETIC_SUBJECTS`, which the owner sets (the maintainers' deploy notes are private). A subject with whitespace inside or over 255 characters stops startup, naming the variable.
- **`instance`, one per task (GWP#86).** `prebutton.instance` is the environment's name, the same on every task, so the API also sets the resource attribute `service.instance.id` to a per-process value: the ECS task id, read at startup from the task metadata endpoint v4 (`ecsTaskId` in `packages/telemetry/src/otel.ts`, 1-second bound; only the task ARN's last segment, since the ARN names the account), else a random UUID. Grafana Cloud's OTLP ingestion maps `service.instance.id` to the `instance` label (and `service.name` to `job`) on metrics and `target_info` ([OTLP format considerations](https://grafana.com/docs/grafana-cloud/send-data/otlp/otlp-format-considerations/)); without it no label told two tasks apart, so during a rolling deploy two overlapping tasks wrote one series and their cumulative counters interleaved (N, 0, N, 0), each drop reading as a reset that `increase()` and `rate()` over-count ([known issue](known-issues/2026-11-01-shared-task-series-and-backlog-count-pileup.md)). **Not yet confirmed live:** this session had no stack credentials, so `--probe-labels` has not run against `dev`; after the first `deploy.yml` run following #86's merge, run `scripts/verify-live.ts` with that run's `Verify live` arguments plus `--probe-labels` to confirm it: the probe prints `target_info`'s label names, which should include `instance`, and Explore shows its values, which should be 32-hex task ids, one per live task, not empty. Log records carry `service.instance.id` too; the same probe prints one Loki line's stream labels and structured metadata, which shows whether Grafana Cloud keeps it as structured metadata, as expected, or promotes it to a stream label (one stream per task); record either here. Every SLO, burn-rate rule, floor and panel sums or maxes across tasks, so they read the same with one series per task; `<env> session purge stalled` sums too (GWP#116, Signals, below), so a deploy does not fire it. Series cost: each live task writes its own set, so the API's active series double for the minutes two tasks overlap in a deploy and the old set goes inactive after it; with one task per environment the steady count is unchanged (free tier, D-042).
- **Which attributes are labels.** Only `deployment_environment` is relied on as a metric label. `service.version` and `prebutton.instance` are expected on `target_info` (the `deployed-version` live check reads `service_version` there), and in Loki `service_name` and `deployment_environment` are expected as stream labels with the rest as structured metadata [inferred from Grafana Cloud's OTLP defaults]. The live checks confirm the ones they select on, on every deploy since #9: `deployed-version` finds `service_version` on `target_info`, and `logs-trace-correlation` selects Loki by the `service_name` and `deployment_environment` stream labels. To see the full sets, run `pnpm exec tsx scripts/verify-live.ts ... --probe-labels` (the deploy's `Verify live` arguments, plus the flag), which prints the labels and structured metadata of one Loki line and `target_info`'s label names; fix any selector that does not match. The CloudWatch series' label names are confirmed (Explore, 2026-10-30, after the owner connected the AWS integration; #72): Grafana Cloud's CloudWatch scrape labels each dimension `dimension_<Name>` and puts the resource ARN in `name`. `aws_ecs_containerinsights_cpu_utilized_average` carries `dimension_ServiceName` (`prebutton-a-getworkdone`, `prebutton-a-getworkdone-dev`); `aws_applicationelb_request_count_sum` carries `dimension_TargetGroup` (`targetgroup/<name>/<hash>`) and `dimension_AvailabilityZone`, so one target group is one series per zone. `ecs-container-insights` and `alb-metrics` select `dimension_ServiceName` and `dimension_TargetGroup` (`observability/live/queries.ts`); `verify-live.ts --probe-labels` prints both series' label names (GWP#72), so a renamed dimension shows in the deploy log before the selectors are edited.

## Burn-rate rules

Every SLO, latency included, has two Grafana-managed alert rules over its own error ratio (`1 - good/all`). A rule fires while the ratio is above `factor x (1 - objective)` on both its windows. The short window lets the alert stop soon after the burn does.

| Speed | Factor | Windows | Severity | Threshold at 99.5 percent | Threshold at 95 percent |
|---|---|---|---|---|---|
| fast | 14.4x | 1 h and 5 m | `critical`: pages | 0.072 | 0.72 |
| slow | 6x | 6 h and 30 m | `warning`: no page | 0.03 | 0.3 |

Each environment's six rules form the group `<env>-slo-burn` in the folder `getworkdone`. The rule uids are `gwd-...` for `getworkdone` and `gwd-dev-...` for `getworkdone-dev`, because Grafana allows 40 characters. Each rule carries the labels `slo`, `severity`, `burn`, `team=getworkdone` and `deployment_environment`. With no traffic the ratio has no samples, and the rule stays `OK` (`noDataState`): no traffic is not a burn. Silence of the whole stack (a dead API, sidecar or token) is the telemetry heartbeat's job (below), so `OK` does not hide it. A rule that cannot evaluate, for example because the datasource is down, goes to `Error` (`execErrState`) with its own labels. A fast-burn rule then pages, by design: an SLO nobody can see is treated as burning. Every rule fires with `for: 0s`; the two windows already debounce.

### The traffic floor (D-090)

A ratio over a handful of requests is noise: on a near-zero-traffic instance one 500 among a dozen requests is above 0.072. So each burn-rate rule also needs a minimum of real requests in a window before it can fire:

| Speed | Floor | Window | Constant (`observability/slo/definitions.ts`) |
|---|---|---|---|
| fast | 20 requests | 5 m, the fast rule's short window | `FAST_BURN_MIN_REQUESTS` |
| slow | 100 requests | 6 h, the slow rule's long window | `SLOW_BURN_MIN_REQUESTS` |

Each rule's expression ends in `and sum(increase(<the SLO's total>[5m])) >= 20` (fast) or `and sum(increase(<the SLO's total>[6h])) >= 100` (slow), where the total is the rule's own SLO total, which keeps `synthetic="false"`, so synthetic traffic (the k6 live smoke) never counts toward the floor. Below the floor the rule stays `Normal` whatever the ratio; the error budget is still spent, and the SLO app and the dashboard's 5xx-share panel still show it. Above the floor the thresholds apply unchanged. `and` keeps the left side's value, the ratio, so the `gt 0` condition is unchanged. `tests/scripts/burn-guard.test.ts` runs the expressions through a small PromQL evaluator (`tests/scripts/promql-eval.ts`): 19 requests, all 5xx, stay quiet; 20 with 2 5xx fire; 20 with 1 does not; 99 all 5xx stay quiet on the slow rule; 100 with 4 fire. The evaluator takes `increase()` as the last sample minus the first; Prometheus also extrapolates to the window's edges, so live the floor can be crossed a request or so early. It is a floor against single errors, not an exact count.

A drill must cross the floor to prove a rule fires: at least 20 real requests in the last 5 minutes for a fast rule (100 in 6 hours for a slow one). `tests/k6/fault-drill.js` drives at least 300 drill requests over five minutes, then one a second, as its non-synthetic `drill` user.

## Signals

Each environment also has the group `<env>-signals` (`observability/signals/definitions.ts`, GWP#53), in the same folder and with the same `team`, `deployment_environment`, `severity` and `runbook_url` conventions, plus a `signal` label naming the rule. It watches what the burn-rate rules cannot see. Every rule has `noDataState: OK`, `execErrState: Error` and the same condition as the burn rules (`gt 0` on an instant query), so a comparison that should fire on 0 is written `== bool 0`: a bare `== 0` keeps the sample's value, 0, which `gt 0` never fires on (`observability/test/definitions.test.ts` fails on a bare one).

| Rule | Expression | For | Severity | `noDataState` | Runbook |
|---|---|---|---|---|---|
| `<env> telemetry heartbeat` | `absent_over_time(session_purge_runs_total{deployment_environment="<env>"}[10m])` | 0s | `critical`: pages | `OK` | [telemetry-heartbeat.md](runbooks/telemetry-heartbeat.md) |
| `<env> session purge stalled` | `sum(increase(session_purge_runs_total{deployment_environment="<env>",status="ok"}[50m])) == bool 0` | 0s | `warning` | `OK` | [telemetry-heartbeat.md](runbooks/telemetry-heartbeat.md) |
| `<env> delivery failed` | `sum(increase(distribution_deliveries_total{deployment_environment="<env>",status="failed"}[1h])) > 0` | 0s | `warning` | `OK` | [delivery-failed.md](runbooks/delivery-failed.md) |
| `<env> delivery backlog` | `max by (deployment_environment) (distribution_deliveries_pending{deployment_environment="<env>"}) > 50` | 30m | `warning` | `OK` | [delivery-failed.md](runbooks/delivery-failed.md) |
| `<env> database unreachable` | `min_over_time(database_ready{deployment_environment="<env>"}[5m]) == bool 0` | 0s | `critical`: pages | `OK` | [database-unreachable.md](runbooks/database-unreachable.md) |

- **Destroying `dev` pauses its rules (GWP#85).** A destroyed `getworkdone-dev` pushes nothing, so its heartbeat would page 10 minutes later and every 4 hours after. After the app stage's destroy, `destroy.yml` runs `apply.ts --pause --environment getworkdone-dev`, which pauses all 11 rules of `getworkdone-dev-slo-burn` and `getworkdone-dev-signals`: it sends each rule whole, as live mode builds it, with `isPaused: true`, and reads it back. It needs only `GRAFANA_URL` and `GRAFANA_TOKEN`, reports a rule the stack does not hold as `absent`, and refuses `getworkdone` with exit 2. Every live apply sends `isPaused: false` (`alertRuleBody`), so the next `deploy.yml` `app-dev` run unpauses them, once its app stage applies, even when a later step fails (GWP#112: a fallback apply runs when "Apply observability" did not). A run cancelled after the app stage with no successful apply warns that the rules may still be paused; a run whose app stage failed or was cancelled runs no unpause and warns that `dev` may be running with its rules paused (GWP#114). A pause that fails only warns; the fallback is a manual silence matching `deployment_environment=getworkdone-dev`, described in the maintainers' deploy notes (private).
- **The heartbeat.** The session purge runs at startup and every 15 minutes (`apps/api/src/modules/auth/session-purge.ts`) and the API exports its metrics every 15 seconds, so `session_purge_runs_total` arrives continuously whether or not anyone uses the app. Its first run waits until the purge's tables exist and the API's database role can log in (GWP#101): an instance whose migrate task never ran or failed records no run and the heartbeat fires after 10 minutes, with one `session purge waiting for the database schema` line in Loki. A database that is unreachable does not hold it back: the purge starts and records `status="error"` runs. While the series is present `absent_over_time` returns an empty vector, which Grafana reads as NoData, and `noDataState: OK` keeps a healthy pipeline quiet (the rule shows `Normal`, not `NoData`). When the series has been absent for 10 minutes (40 export intervals) the query returns 1 and the rule fires: a dead API, sidecar or access-policy token pages within about 11 minutes. Previewing the query against an environment with no series, such as `deployment_environment="getworkdone-none"`, returns 1.
- **Purge stalled** means telemetry arrives but no task finished a purge `ok` in 50 minutes (three missed runs): the purge, not the pipeline. The rule sums `increase()` across tasks (GWP#116), so it reads every task's series together: in a rolling deploy the new task's series, born at 1 by its startup purge, and the old task's stopped series, whose last samples in the window are flat, each read 0 alone, but the sum still holds the other task's runs, and the rule stays quiet. A purge that fails on every task warns. A missing series is the heartbeat's: the empty sum is NoData, kept `Normal` by `noDataState: OK`. It can still warn once for about 15 minutes after a new environment's first deploy (or a recreate after a destroy): the first `ok` run creates the only series at 1, and `increase()` needs the second run to see a change. `tests/scripts/signal-rules.test.ts` evaluates it every minute of the hour after a deploy.
- **Delivery failed** opens an alert group in OnCall and pages nobody: a failed delivery is final and the item stays `completed` ([outputs.md](outputs.md) "Deliveries"); a person decides whether to add the output again. An OTel counter series is born at its first value, so at bootstrap the API starts `distribution_deliveries_total{kind,status="failed"}` at 0 for `email` and `webhook` (`primeFailedDeliveries`, called by `delivery.backlog.ts`); otherwise a task's first failure would read 1, 1, 1 and `increase()` would see nothing. `tests/scripts/signal-rules.test.ts` runs all five expressions through the evaluator over recorded samples, that case included. Each task primes its own series, and the rule sums across tasks, so a deploy does not fire it for an old failure (the same test file, with per-task series).
- **Delivery backlog** means the worker is not draining (a stuck lease, a receiver that times out every attempt). Every task reports the same count, each on its own series, so the rule and the panel take `max by (deployment_environment)`.
- **Database unreachable** reads the in-process readiness check (below) and fires when any task recorded a failed check in the last 5 minutes.

### Metrics the signals read

Beside the RED metrics, `packages/telemetry/src/metrics.ts` records:

- `session_purge_runs_total{status}` (GWP#16), the heartbeat.
- `database_ready` (gauge, GWP#53): 1 when the last readiness check reached the database, else 0. `apps/api/src/modules/health/readiness.ts` runs `SELECT 1` through the shared Prisma client with a 2-second timeout, at startup and every 30 seconds (`READINESS_INTERVAL_MS`; off under `NODE_ENV=test`), and records it. `GET /readyz` serves the last result while it is under 30 seconds old, else checks again: 200 `{ status: 'ok', database: 'ok' }` or 503 `{ status: 'degraded', database: 'down' }` (`ReadyResponse` in `@getworkdone/contracts`). It is open like `/healthz`, outside `/api/v1`, so no SLO counts it; its RED route label is `/readyz`. The ALB health check stays `/healthz`.
- `process_sweeper_runs_total{status}` and `process_sweeper_items_total{result}` (GWP#55), each run of the stuck-item sweeper and the items it resumed, skipped or failed to advance ([process.md](process.md) "Resume"); no rule or panel reads them.
- `distribution_deliveries_pending` (observable gauge, GWP#53): `COUNT(*) FROM "Delivery" WHERE status = 'pending'`, served by the `[status, nextAttemptAt]` index, read on each export with a 5-second timeout (`registerDeliveryBacklog`, registered at bootstrap by `apps/api/src/modules/distribute/delivery.backlog.ts`). A read that fails or times out records nothing for that export; under the API's cumulative temporality the exporter then repeats the last value it sent. While a count is still outstanding (a blackholed database), the next export waits on that count again instead of starting another, so a task never has more than one backlog count in the pg pool (GWP#86), as the readiness check does for its `SELECT 1`.

## Alerting and OnCall

- **Contact point.** There is one contact point, `getworkdone-oncall`, of type `oncall`. Its URL is the `link` of the OnCall integration that `apply.ts` creates or finds; `contactPoints()` refuses an empty, non-https or `.invalid` URL. No contact point is `email`.
- **Notification policy (shared stack, read-modify-write; GWP#171).** The stack is shared with other tenants (the fleet's routes and rules live there too), and a `PUT` replaces the whole tree, so `apply.ts` owns only one top-level route and merges it into the tree it reads (`mergePolicy` in `observability/alerting/definitions.ts`). The owned route is the one whose `object_matchers` are exactly `team=getworkdone` (every burn-rate and signal rule carries it): it sends to `getworkdone-oncall` and groups alerts by `alertname`, `slo` and `deployment_environment`, and it leaves `continue` unset, because Grafana does not read back a false one. `apply.ts` GETs the tree, replaces the first owned route in place (dropping any later copy) or appends it when there is none, passes every other route, nested route and root field through in order, and PUTs the result; a tree already merged gets no PUT. The root receiver becomes `getworkdone-oncall` only while it is the stack default (`grafana-default-email` or empty), so nothing falls back to email on a fresh stack; any other root receiver is left as is and reported (`notification-policy root: receiver … is not the stack default, left as is`). That includes `getworkdone-oncall` itself while the tree holds other tenants' routes, because the root then also receives their alerts that no route matches; moving it back to a shared receiver is the stack owner's call, not `apply.ts`'s. The PUT carries no version, so another tenant's write between the GET and the PUT can still be lost.
- **OnCall team (D-042).** `prebutton-maintainers` mirrors the GitHub CODEOWNER team `@foolswithtools/prebutton-maintainers`. OnCall teams are Grafana teams that IRM syncs ([Teams](https://grafana.com/docs/grafana-cloud/observe-and-act/respond-to-incidents/set-up/manage-access/teams/)). `apply.ts` creates the Grafana team, adds the user whose login is in `GRAFANA_ONCALL_OWNER`, then reads the synced OnCall team. IRM syncs teams when an IRM page loads, or else every 4 hours. On a first apply, `apply.ts` therefore exits 1 and says to open IRM once, then re-run. No definition names a person. Further members are added by hand, and `apply.ts` keeps them.
- **Escalation chain.** `getworkdone-page` has exactly one step, `notify_team_members` for the team, marked important. `apply.ts` removes any other step.
- **Integration and routes.** The integration is `getworkdone-alerting`, of type `grafana_alerting`. Its jinja2 route `{{ payload.commonLabels.severity == "critical" }}` goes to `getworkdone-page`, so fast burns, the telemetry heartbeat and database unreachable page. Its default route has no escalation chain, so warnings (slow burns, purge stalled, delivery failed, delivery backlog) open an alert group in OnCall and page nobody.

## Dashboards

`<env>-red` sits in the `getworkdone` folder. It starts with six panels:
- request rate by status class;
- 5xx share;
- p95 duration, with the 0.8 s SLO line;
- the 1-hour burn rate of each SLO, with lines at 6x and 14.4x;
- deliveries per hour by `kind` and `status` (GWP#53);
- pending deliveries (`max by (deployment_environment)`), with a line at 50, the backlog rule's threshold (GWP#53).

Below them is one row per SLO (GWP#58), titled with the SLO's id (`<env>-api-availability`, `<env>-api-latency`, `<env>-capture-availability`), each with four panels:
- **SLI over 5 m:** `sum(rate(<good>[5m])) / sum(rate(<all>[5m]))`, with a line at the objective;
- **burn rate over 1 h** and **burn rate over 6 h:** the fast and slow rules' long windows, the error ratio divided by `1 - objective`, with lines at 6x and 14.4x (`BURN_RATES`);
- **budget consumed over the dashboard range (at most 14 days):** a stat, `1 - SLI` over Grafana's `$__range` divided by `1 - objective`. 100 percent means the range's requests spent exactly their share of the budget; above it, the range burned faster than the 28-day budget allows.

The range caveat: metrics are kept 14 days (free tier, below), so a range longer than 14 days still covers at most 14 days of data. The stat is not the 28-day attainment; the SLO app shows that, and it is partial for the same reason. Panel ids are `10n` for the n-th SLO's row and `10n+1` to `10n+4` for its panels, so they stay stable while the SLO list keeps its order.

Every query is scoped to the environment. The request panels and the SLO rows leave out synthetic traffic; the delivery series carry no `synthetic` label. Panels aggregate and never split by team or item (free tier). The rows add queries, not series.

## Logs (GWP#58)

The API writes every log line twice (D-044): as JSON on stdout, which the task's log driver sends to the module's CloudWatch log group (`/ecs/prebutton-a-getworkdone-dev` for `dev`), and as an OTel log record that the Alloy sidecar sends to Loki with its `trace_id`. CloudWatch bills ingestion per GB; Loki's free tier is 50 GB a month. So stdout carries only part of it:

- **`LOG_STDOUT_LEVEL`.** The lowest level written to stdout. When unset it is `warn` once `setupOtel` has built the OTLP log exporter (a deployed task), and every line otherwise (local runs, CI and `OTEL_SDK_DISABLED=true`, unchanged). An unknown value falls back to that default, and `fatal` or `silent` is capped at `error`, so error and fatal lines always reach stdout (GWP#134). The OTel record is written for every line either way; `LOG_LEVEL` (default `info`) is still the floor for both. The app stage sets it from its input `log_stdout_level` (`trace`, `debug`, `info`, `warn` or `error`; empty leaves it unset), which `deploy.yml` fills from the GitHub environment variable `GETWORKDONE_LOG_STDOUT_LEVEL`, optional, in `getworkdone-dev` and `getworkdone` alike. To see `info` lines in CloudWatch, for example while the sidecar is down, the owner sets that variable to `info` and redeploys (a push to `main` for `dev`, the promote dispatch for `prod`); deleting it and redeploying restores `warn`. Editing the task definition by hand does not last: the next apply puts back the stage's.
- **The startup exemption.** A line carrying `startup: true` reaches stdout at any level, so a task that dies before its telemetry still leaves a trace in CloudWatch. The API's `listening` line and its `quotas` line (the effective quota limits, GWP#134) carry it.
- **The stdout fields.** Every API line carries `service`, `service_version`, `deployment_environment` and `prebutton_instance` (from `GETWORKDONE_VERSION`, `GETWORKDONE_ENVIRONMENT` and `GETWORKDONE_INSTANCE`, `apiLoggerBindings` in `apps/api/src/common/logger.ts`), named as Loki names the resource attributes (dots to underscores), so a CloudWatch line and a Loki line use the same field names. The OTel record does not repeat the last three: they are its resource attributes already. Redaction is unchanged; both copies are scrubbed.

To check on `dev` (acceptance): `aws logs filter-log-events --log-group-name /ecs/prebutton-a-getworkdone-dev --filter-pattern '{ $.level = "info" }'` over a window with traffic returns only lines with `startup: true`, while Loki (`{service_name="getworkdone-api", deployment_environment="getworkdone-dev"}`) holds the window's `info` records (severity text `info`) with `trace_id`.

## Sampling (GWP#58)

Traces are sampled in the Alloy sidecar, not in the API. The API's SDK keeps its default sampler, `parentbased_always_on`, so it sends every span to the sidecar on loopback. The sidecar's `otelcol.processor.tail_sampling` (`deploy/alloy/config.alloy`) holds each trace for `decision_wait = "10s"`, then keeps it if any of its policies matches (they are evaluated together, with no order):

| Policy | Keeps |
|---|---|
| `errors`: `status_code` `ERROR` | every trace with an errored span (the API sets `ERROR` on a 5xx) |
| `slow`: `latency` above 800 ms | every trace slower than the latency SLO's threshold (`LATENCY_THRESHOLD_SECONDS`) |
| `synthetic`: `and` of `boolean_attribute gwd.synthetic = true` and `probabilistic 5` | 5 percent of probe traffic |
| `real`: `and` of `boolean_attribute gwd.synthetic = true, invert_match = true` and `probabilistic 20` | 20 percent of the rest |
| `live-smoke`: `and` of `boolean_attribute gwd.synthetic = true` and `string_attribute http.route = "/api/v1/me"` | every synthetic `GET /api/v1/me` trace: the live smoke's, which `trace-end-to-end` (below) looks up in Tempo after every deploy, so at 5 percent the deploy would fail 19 times in 20. One request per deploy |

The API's request span carries `gwd.synthetic = true` when `isSynthetic` says so (a verified subject in `SYNTHETIC_SUBJECTS`, the same judgement as the RED `synthetic` label). It is set when the response finishes, because the subject is only known after the guard runs (`httpServerSpans({ synthetic })`, `packages/telemetry/src/http.ts`); other requests have no such attribute, and no header sets it. The inverted match sits inside an `and`, where a miss only fails that policy, so it never drops a trace another policy keeps. The probabilistic policies hash the trace id, so a trace's API and request-4-change edge spans are kept or dropped together; an edge-only trace has no `gwd.synthetic` and falls under `real`. The ALB's health checks are anonymous, so their `/healthz` traces fall under `real` too.

Two limits of the 10-second wait: the SDK's batch processor sends spans every 5 seconds, and the sampler decides 10 seconds after a trace's first span arrives. So a request that runs longer than about 5 seconds, with child spans sent before its server span ends, can be decided before its `ERROR` or its duration is seen, and then falls under the ratio. Such a request also misses the latency SLO; its RED data point is recorded either way.

Why not the SDK's own knob: the SDK reads `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG` (`packages/telemetry/src/otel.test.ts` pins it), but the SPA mints every `traceparent` with flags `01`, sampled (`apps/web/src/traced-fetch.ts`), so any parent-based ratio keeps every SPA-initiated trace. Head sampling of any kind also cannot keep errors: a span's status is known only when it ends. The metrics are not sampled: RED comes from the interceptor, not from spans, so the SLOs and alerts see every request.

**Fallback.** If the sidecar's memory for tail sampling (traces held for 10 s; the processor's default cap of 50,000 traces) is too much for the task, remove the `tail_sampling` block (route the receiver's `traces` to the batch processor again) and set `OTEL_TRACES_SAMPLER=traceidratio` and `OTEL_TRACES_SAMPLER_ARG=0.2` in the task definition's environment (`deploy/sandbox/app`). That needs no code; it keeps 20 percent of all traces, errors included, and is not parent-based, so the SPA's flag does not defeat it. But it also keeps only 20 percent of the live smoke's trace, so `trace-end-to-end` would then fail about four deploys in five: switch to the fallback only together with a change to that check. The Playwright e2e trace test uses a test exporter and is unaffected either way.

To check on `dev` (acceptance): over one hour of traffic, the traces in Tempo for `deployment.environment = getworkdone-dev` are between 15 and 30 percent of `http_server_requests_total`'s increase for non-synthetic routes, and every request that answered 5xx in that hour has a trace (after a fault drill, Tempo holds a trace with an `ERROR` span from the drill window).

## request-4-change's edge (GWP#10)

The task's `edge` sidecar (request-4-change's server with `R4C_ROLE=edge`, [r4c.md](r4c.md)) exports OTLP over HTTP to the same Alloy receiver as the API (`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`, D-027), so its traces and metrics land in this stack as `service.name` `request-4-change-edge`, with `deployment.environment` the API's own (`getworkdone-dev` or `getworkdone`, from `R4C_DEPLOYMENT_ENVIRONMENT`) and `r4c.instance` `dev` or `prod` (edge's attribute; it sets no `prebutton.instance`). The widget sends a sampled `traceparent` with each submit and edge continues it, so a submit's trace holds edge's spans. The widget contract names no `traceparent` on its token GET, so the API's `GET /api/v1/r4c/token` span is expected in a trace of its own [inferred from widget contract v1; the first live run of the widget confirms it]. Control's spans are request-4-change's export, not this stack's. The SLOs and signals stay the API's: their selectors need `synthetic="false"`, a label only the API's RED metrics carry, and the API's routes, so edge's series under the same `deployment_environment` do not enter them.

## Credentials (D-042)

The owner creates the credentials in the new free-tier stack and the Cognito pools. None goes in the tree, a workflow or an image (D-035).

| Credential | Used by | Needs |
|---|---|---|
| Access-policy token for Alloy | the Alloy sidecar (GWP#8) | the scopes `metrics:write`, `logs:write`, `traces:write` and `profiles:write` ([Access policies](https://grafana.com/docs/grafana-cloud/security-and-account-management/authentication-and-permissions/access-policies/)) |
| Stack service-account token | `apply.ts`, `scripts/verify-live.ts`, OnCall's API and the alert drill (GWP#9), at deploy time; `apply.ts --pause` when `destroy.yml` destroys `dev` (GWP#85) | role **Admin** (see below). Stored in `getworkdone/deploy/grafana-stack-token`, which only the deploy role reads (`.github/actions/read-deploy-secret`, D-071); no workflow uses the secrets context |
| k6 users' credentials | the live smoke (`synthetic` user per instance) and the alert drill (`drill` user, dev) | Cognito users with permanent passwords; JSON in `getworkdone/deploy/k6-credentials`, put by the owner |

The service account needs the Admin basic role. Grafana documents no single recipe for this set of permissions, so the requirement is pieced together from these needs:
- SLO writes need `grafana-slo-app.slo:write` and folder write ([SLO RBAC](https://grafana.com/docs/grafana-cloud/alerting-and-irm/slo/set-up/rbac/)).
- OnCall integrations and escalation chains need the IRM admin role `plugins:grafana-irm-app:admin`; the IRM editor role cannot create them ([plugin roles](https://grafana.com/docs/grafana-cloud/platform/security-and-account-management/security-and-access/authentication-and-permissions/access-control/plugin-role-definitions/)).
- Teams need `teams:create` and `teams.permissions:write`.
- The owner lookup needs `org.users:read`.
- Alert rules, contact points, notification policies, folders and dashboards need write access.

Every `deploy.yml` run since GWP#9 applies with this role, so it is enough.

## Running apply.ts

```
pnpm --filter @getworkdone/observability exec tsx apply.ts --dry-run                       # plan getworkdone, no network
pnpm --filter @getworkdone/observability exec tsx apply.ts --dry-run --environment getworkdone-dev
pnpm --filter @getworkdone/observability exec tsx apply.ts --environment getworkdone        # live
```

`--dry-run` prints every object it would provision and a summary: 3 SLOs, 6 burn-rate rules, 5 signal rules (11 alert rules in 2 groups, `<env>-slo-burn` and `<env>-signals`), 1 contact point and 1 dashboard.

In live mode, `apply.ts` reads:

| Variable | What |
|---|---|
| `GRAFANA_URL` | the stack, `https://<stack>.grafana.net` |
| `GRAFANA_TOKEN` | the stack service-account token |
| `GRAFANA_ONCALL_URL` | the OnCall API URL shown under IRM > Settings > Admin & API ([OnCall API](https://grafana.com/docs/grafana-cloud/alerting-and-irm/irm/reference/oncall-api/)) |
| `GRAFANA_ONCALL_OWNER` | the owner's Grafana login |
| `GRAFANA_PROM_DATASOURCE_UID` | optional; the hosted metrics datasource, `grafanacloud-prom` by default |

Stack requests send the token as a bearer token. OnCall requests send the bare token with `X-Grafana-URL`, because OnCall only accepts a header that starts with the token itself. Each object is created or updated, then read back (GET after write), and a difference exits 1, naming the object and the field. An object that already matches is left alone, so a second run makes no writes.

Each run provisions one environment's SLOs, both rule groups and dashboard. The OnCall objects, contact point, folder and policy tree are shared by both environments and come out the same from either run.

| Exit code | Meaning |
|---|---|
| 0 | Planned, or applied and verified. |
| 1 | A request failed, a read-back differed, OnCall has not synced the team, or the owner's login is not a stack user. |
| 2 | Usage error: a bad argument, a missing or non-https `GRAFANA_URL`, `GRAFANA_TOKEN`, `GRAFANA_ONCALL_URL` or `GRAFANA_ONCALL_OWNER`. It exits before any request. |

`observability/test/apply.test.ts` runs it against an in-memory stack (`observability/test/fake-grafana.ts`) shaped after the documented APIs. Some details are not confirmed in Grafana's docs; every deploy's live apply, which reads each object back, has confirmed them since GWP#9:
- the SLO app's `freeform` query body;
- the `oncall` contact point type (the IRM guide shows a `webhook` contact point);
- the integration's `link` field.

## Free-tier limits

From [Grafana Cloud pricing](https://grafana.com/pricing/) and [usage limits](https://grafana.com/docs/grafana-cloud/cost-management-and-billing/manage-invoices/understand-your-invoice/usage-limits/), checked 2026-10-22:

| Limit | Free tier | GetWorkDone |
|---|---|---|
| Metrics | 10k active series | RED series are per route, method, status code and `synthetic`, and per task (`instance`, GWP#86): a deploy's overlapping tasks double them for a few minutes; panels aggregate and never split by item, team or task |
| Logs, traces, profiles | 50 GB each | |
| Retention | 14 days for every signal | **Shorter than the 28-day SLO window**: until the stack leaves the free tier, the SLO app's 28-day attainment covers at most 14 days of data. The burn-rate rules look back 6 hours at most and are unaffected, and dashboards default to 6 hours. |
| IRM users | 3 active | the owner, plus up to two members added by hand |
| Alert rules | 35 rule groups per stack, 20 rules per group | 4 groups: per environment, `<env>-slo-burn` (6 rules) and `<env>-signals` (5 rules); `definitions.test.ts` keeps each group under 20 |

## Volume baselines (GWP#58)

The defaults above (`LOG_STDOUT_LEVEL` `warn`, traces 20 percent and 5 percent synthetic, errors and slow traces always) are a first guess. After seven days live on `dev` the owner records the first row here and as a comment on GWP#58 (its disposition log), and adjusts `LOG_STDOUT_LEVEL` or the ratios in a small follow-up PR if a limit is near.

| Date | Logs GB per day, CloudWatch | Logs GB per day, Loki | Spans per day kept | Spans per day dropped | Active series |
|---|---|---|---|---|---|
| to be measured | `getworkdone-dev`, seven days after GWP#58 deploys | | | | |

Where to read them: CloudWatch's `IncomingBytes` for the log group; Grafana Cloud's usage dashboards (Billing/Usage) for Loki bytes and active series; spans kept are Tempo's ingested spans (Grafana Cloud usage). Alloy counts kept and dropped traces in its own `otelcol_processor_tail_sampling_*` metrics, but the config does not export Alloy's own metrics, so the dropped count is an estimate: each request is one API server span, so `http_server_requests_total`'s daily increase less the kept server spans (`kind = server` in Tempo) is the dropped server spans.

## Coverage manifest status

`specs/observability-coverage.yaml` sets no status by hand (the exemplar's "24/24 passing" was hand-edited, `prebutton.md:350`). Each feature names a check:

- `check: { kind: test, file, test }` is `passing` when that test passed in this run's report, and `failing` when it failed, was skipped, or the report or result is missing. The report is `reports/vitest-unit.json`, `reports/vitest-integration.json` or `reports/playwright-e2e.json`, chosen by the file name.
- `check: { kind: live, query }` names an id in `observability/live/queries.ts` and reports `pending-live`.

No `status` key may appear anywhere in the manifest, at any depth, and no line may contain the text `status:`, not even a comment. This keeps `grep -n "status:"` empty.

`scripts/coverage-status.ts` runs the checks after the test gates and writes `reports/coverage-status.json`. `scripts/coverage-check.ts` reads only that file. It fails on:
- a failing feature;
- a manifest problem: a `status:` key, a check whose file or test does not exist, an unknown live query, or a duplicate id;
- a broken D-026 rule.

In PR CI, `pending-live` passes. After every app apply, `deploy.yml` runs the live checks (below) and calls `coverage-check.ts --require-live`, which fails on any feature still pending or failing.

## Live verification (GWP#9)

`app-dev` and `promote`, after the digest check and the HTTPS probe, run in order: `apply.ts --environment <env>` live; `k6 run tests/k6/live-smoke.js` as the instance's `synthetic` user; `scripts/verify-live.ts`; `scripts/coverage-check.ts --require-live`. The live smoke signs in through the hosted UI, captures one item in its own team `k6-synthetic` (work type `k6-smoke`, output `none`) and sends a minted `traceparent` on every request, as the SPA does. It writes the trace id and span id of its `GET /api/v1/me` to `reports/k6-live.json`.

`verify-live.ts` runs each `kind: live` feature of the manifest through the stack's datasource proxy (Prometheus `grafanacloud-prom`, Tempo `grafanacloud-traces`, Loki `grafanacloud-logs`, Pyroscope `grafanacloud-profiles`; `GRAFANA_*_DATASOURCE_UID` overrides each) and OnCall's API. It writes `reports/coverage-status.json` with the live features only, because PR CI has already enforced the test features. Telemetry takes minutes to arrive, so failing checks are retried for up to 10 minutes (`--retry-for 600`). `$environment` is matched exactly, never with `=~`, so a `getworkdone-dev` series never satisfies a `getworkdone` check.

| Feature (query id) | Datasource | Passes when | On failure |
|---|---|---|---|
| `ecs-container-insights` | Prometheus | `count(aws_ecs_containerinsights_cpu_utilized_average{dimension_ServiceName="<service>"})` is above 0 | the owner connects the AWS integration (CloudWatch metrics into Grafana Cloud); `verify-live.ts --probe-labels` prints both CloudWatch series' label names (GWP#72) |
| `alb-metrics` | Prometheus | `count(aws_applicationelb_request_count_sum{dimension_TargetGroup=~"targetgroup/<name>/[0-9a-f]+"})` is above 0; anchored at the `/` after the name, because the dimension is `targetgroup/<name>/<hash>` | the same |
| `alloy-pipeline` | Prometheus | `count(http_server_requests_total{deployment_environment="<env>",synthetic=~".+"})` is above 0 (the `synthetic` label is the API's own, so edge's series in the same environment cannot pass it, GWP#10) | the Alloy token and endpoints |
| `synthetic-smoke` (`k6-smoke`) | Prometheus | `count(http_server_requests_total{deployment_environment="<env>",synthetic="true"})` is above 0 | the live smoke did not run, or its `sub` is not in `GETWORKDONE_SYNTHETIC_SUBJECTS` |
| `deployed-version` | Prometheus | `count(target_info{deployment_environment="<env>",service_version="<sha>"})` is above 0 | the deployed task is not the build, or `service.version` is not on `target_info` |
| `trace-end-to-end` | Tempo, `GET /api/traces/<trace id>` | a span of kind `SERVER` named `GET /api/v1/me`, whose `parentSpanId` is the span id k6 sent, in a resource with `service.name=getworkdone-api`, `deployment.environment=<env>` and `service.version=<sha>` | the traces pipeline or the propagator |
| `logs-trace-correlation` | Loki | `{service_name="getworkdone-api", deployment_environment="<env>"} \| trace_id="<trace id>"` returns a line in the last hour | the logs pipeline or the Loki labels (`--probe-labels`) |
| `profiles-live` (`profiles`) | Pyroscope | the label values of `service_name` for `{deployment_environment="<env>"}` in the last 15 minutes include `getworkdone-api` | the Alloy Pyroscope receiver and the API's profiling |
| `oncall-routing-live` (`oncall-routing`) | OnCall and alerting APIs | the integration `getworkdone-alerting` exists, and the policy tree's `team=getworkdone` route's receiver is `getworkdone-oncall` | run `apply.ts` |
| `readiness` (`readyz`) | the instance itself | `GET https://<hostname>/readyz` answers 200 with `{"status":"ok","database":"ok"}` (`ReadyResponse`); the request carries no stack token | the API cannot reach its database ([runbooks/database-unreachable.md](runbooks/database-unreachable.md)) |
| `alert-fault-injection` (`burn-rate-alert-pages-oncall`) | the SSM parameter `/getworkdone/dev/drill/last-result` | the last alert drill recorded an OnCall alert group for both the availability and the latency rule. It is the evidence for both environments: the rules are the same code, the integration is shared, and prod has no fault route. Absent: `pending-live`. Stale, also `pending-live` (GWP#72): dated more than 30 days before the check, or on dev dated before the service was created (`--service-created-at`, from `describe-services`); `destroy.yml` deletes the result with the dev app stage | run `alert-drill.yml` once (docs/runbooks/alert-drill.md) |

A live check that a new release adds fails against an older image: promoting a digest built before GWP#53 to an instance fails `readiness`, because that image serves no `/readyz`, so `coverage-check.ts --require-live` fails the job after the apply. That is expected for a rollback past the check.

The end-to-end trace claim is exactly the `trace-end-to-end` row: the browser emits no spans (D-089), the SPA sends `traceparent`, and the API server span adopts its trace id and parent.

The response shapes of Tempo (`batches` or `resourceSpans`, ids in hex or base64), Loki (`categorize-labels` structured metadata), Pyroscope (`querier.v1.QuerierService/LabelValues`) and OnCall are coded against their documented APIs; the `trace-end-to-end`, `logs-trace-correlation`, `profiles-live` and `oncall-routing-live` checks pass on every deploy, which confirms the shapes they read.

## Fault injection and the alert drill (GWP#9)

The API mounts the fault module only when `FAULT_INJECTION_ENABLED=true`, which only the `dev` task definition sets (the app stage refuses it and `FAULT_ADMIN_SUBJECTS` for `prod`). Without it neither route exists: `POST /api/v1/__fault` is 404 before any guard, and `GET /api/v1/__drill` reaches the SPA route (401 anonymous, 404 signed in).

- `GET /api/v1/__drill` is signed in and has no team. It answers `200 { ok: true }`, so it counts in the `/api/v1` API SLOs and never in the capture SLO.
- `POST /api/v1/__fault` `{ mode: 'errors' | 'latency' | 'off', count? }` needs a subject in `FAULT_ADMIN_SUBJECTS` (`FaultAdminGuard`, else 403), checked after the global guards, so the CSRF token applies. `@RequireTeamRole` cannot guard it: the route has no `:teamId`, and anyone becomes a team admin by creating a team.
  - `errors` fails the next `count` drill requests (default 500, at most 5,000) with 500.
  - `latency` makes every drill request wait 1.2 s, above the 0.8 s boundary.
  - Either fault lapses 60 minutes after it was set; `off` clears it. The state is per task, and the service runs one.
- `FAULT_ADMIN_SUBJECTS` is kept apart from `SYNTHETIC_SUBJECTS`. The drill user's 500s must spend the error budget, and the smoke user must not be able to inject faults.

`.github/workflows/alert-drill.yml` drives both faults through `tests/k6/fault-drill.js` until each fast-burn rule fires and OnCall opens an alert group, then writes the result for the `alert-fault-injection` check ([docs/runbooks/alert-drill.md](runbooks/alert-drill.md)). Every burn-rate rule carries a `runbook_url` annotation that points at `docs/runbooks/<slo short id>-burn.md` in this (private) repo, and every signal rule one at its runbook (the table under "Signals"); the links go to the private repo's copy, which on-call maintainers can open. The public snapshot carries `docs/runbooks/` too, as of its tag.

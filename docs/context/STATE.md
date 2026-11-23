# GetWorkDone-private state

The index for cross-session state (spec P6). It holds decisions and links only: it points at the files that hold the detail and never copies them. Slice status lives in [../ROADMAP.md](../ROADMAP.md); the block below is generated from it.

| What | Where |
|---|---|
| Program spec and decision register | `foolswithtools/prebutton` `docs/specs/2026-10-12-prebutton-program.md` §9.4 (this repo: §3.5, §4.3, §7.1, §7.2) |
| Roadmap with status markers | [../ROADMAP.md](../ROADMAP.md) |
| Known issues and resolved bugs | [../known-issues/README.md](../known-issues/README.md) |
| Domain model: entities, tenancy rule, output semantics (GWP#2) | [../domain.md](../domain.md) |
| Sign-in, sessions, CSRF and team authorization; plugging in another IdP (GWP#3); a sign-in replaces the browser's session, `POST /auth/logout/all` signs a person out everywhere, the Cognito pools' MFA (moved to GWP#130) and threat-protection decision (GWP#56) | [../auth.md](../auth.md) "The flow", "Cookies and sessions", "Amazon Cognito in the sandbox" |
| Capture: field types and their validation, safe patterns, the builder and the capture routes (GWP#4) | [../capture.md](../capture.md) |
| Process: step kinds, the transform catalogue, transitions and idempotency, the retry rule, the step editor and item view (GWP#5) | [../process.md](../process.md) |
| Outputs: kinds, deliveries and idempotency, the retry policy, webhook signatures and blocked ranges, email transports, exports (GWP#6) | [../outputs.md](../outputs.md) |
| Team membership: admins list, add and remove members (`/api/v1/teams/:teamId/members`); a team always keeps an admin, checked under the team's row lock; the Members panel (GWP#20) | [../auth.md](../auth.md) "Team membership" |
| Resume: `POST .../items/:itemId/advance` (admin) moves on an item whose processing stopped between transitions; capture answers 201 with the item when processing fails after it is created; Resume in the item view (GWP#22) | [../process.md](../process.md) "Resume" |
| Waiting for you, archive and the stuck-item sweeper: `GET .../items?waiting=me` lists the items waiting at a human step whose role the caller holds (`Item.waitingRole`, kept by every transition); admins archive and unarchive a work type (`WorkType.archivedAt`; capture and new versions 409 while archived); the sweeper advances stopped items with no actor every `STUCK_ITEM_SWEEP_MS` once `STUCK_ITEM_AFTER_MS` still (GWP#55) | [../process.md](../process.md) "How an item moves", "Resume", "The API" and "In the SPA" |
| Editing data: `POST .../items/:itemId/data` (admin) replaces a failed or waiting item's data, validated against its own version, with a `data_edited` event naming the changed keys only; Edit data in the item view (GWP#23) | [../process.md](../process.md) "Editing data", [../known-issues/2026-10-24-item-data-edit-stale-form.md](../known-issues/2026-10-24-item-data-edit-stale-form.md) |
| Capture follow-ups: one 422 `{ errors }` shape on both definition routes, item paging by cursor, the per-version matcher cache, the capture page's stale-version reload (GWP#21) | [../capture.md](../capture.md) "The API", [../known-issues/2026-10-24-capture-stale-version-and-error-shapes.md](../known-issues/2026-10-24-capture-stale-version-and-error-shapes.md) |
| Export limits: one per work type every 30 seconds (429, `Retry-After`), 10 kept per work type, a team's exports older than 7 days deleted on its next export (GWP#25) | [../outputs.md](../outputs.md) "Exports", [../known-issues/2026-10-24-export-store-lock-and-timeout.md](../known-issues/2026-10-24-export-store-lock-and-timeout.md) |
| Exports panel hold: after a 429 the button stays disabled for the `Retry-After` seconds and the panel counts them down (GWP#35) | [../outputs.md](../outputs.md) "In the SPA" |
| Test isolation for deliveries: integration rows end before the file does; e2e runs on its own scratch database (GWP#26) | [../outputs.md](../outputs.md) "Test isolation" |
| Quotas: outputs and recipients caps, per-subject and per-team windows (GWP#50) | [../domain.md](../domain.md) "Limits and quotas" |
| Security response headers: HSTS, the CSP (verbatim, with each directive's reason and the r4c widget allowances), nosniff, Referrer-Policy, X-Frame-Options, Permissions-Policy, COOP and CORP on every response; how to test a change (GWP#48) | [../security.md](../security.md) |
| Database access: the API's DML-only role `getworkdone_app` (`packages/db/sql/app-role.sql`, created by the migrate task from the owner-filled `getworkdone/<instance>/db-app`), verified TLS to RDS for both consumers against the committed CA bundle, `DATABASE_SSL_ROOT_CERT` (GWP#57) | [../domain.md](../domain.md) "Rules the database enforces", [../../deploy/rds/README.md](../../deploy/rds/README.md), the migrations and owner steps for #57 (the maintainers' deploy notes, private) |
| Observability as code: SLOs, burn-rate rules, OnCall routing, dashboards, apply.ts, credentials and free-tier limits (GWP#7) | [../observability.md](../observability.md) |
| Observability coverage manifest; its status comes from scripts/coverage-status.ts (GWP#7) | [../../specs/observability-coverage.yaml](../../specs/observability-coverage.yaml) |
| Live verification, the k6 smokes and the alert drill: SYNTHETIC_SUBJECTS and FAULT_ADMIN_SUBJECTS, the dev-only fault and drill routes, the live checks deploy.yml runs after every app apply (`scripts/verify-live.ts`), the deploy-time secrets under `getworkdone/deploy/` (GWP#9); the drill result's 30-day age and dev-service-created-at rules, `--probe-labels` on the CloudWatch series, `destroy.yml` deleting the dev drill result, and why `Verify live` names the services itself (GWP#72) | [../observability.md](../observability.md) "Live verification", the owner steps for live verification and the alert drill (the maintainers' deploy notes, private), [../runbooks/](../runbooks/alert-drill.md) |
| Signals beside the burn-rate rules: the `<env>-signals` group (telemetry heartbeat, session purge stalled, delivery failed, delivery backlog, database unreachable), the burn-rate traffic floor (D-090), `GET /readyz` and the in-process readiness check, the `database_ready` and `distribution_deliveries_pending` gauges, the delivery panels, the live `readyz` check (GWP#53) | [../observability.md](../observability.md) "Signals" and "The traffic floor (D-090)", liveness and readiness in the sandbox (the maintainers' deploy notes, private), [../runbooks/README.md](../runbooks/README.md) |
| Telemetry volume and the per-SLO dashboard rows: `LOG_STDOUT_LEVEL` (stdout at `warn` once logs go over OTLP, `startup: true` lines kept), the four resource fields on every API log line, the Alloy sidecar's tail sampling (errors, slow, 5 percent synthetic via `gwd.synthetic`, 20 percent the rest, the live smoke's trace always) and its `traceidratio` fallback, one dashboard row per SLO, the volume baselines (GWP#58) | [../observability.md](../observability.md) "Logs", "Sampling", "Dashboards" and "Volume baselines" |
| SPA addresses: every view's path, Back and Forward, deep links and the path kept across sign-in (GWP#98) | [../web.md](../web.md) "Addresses" |
| Guides for the people using GetWorkDone: the first team, step by step, and running a team as its admin (GWP#52) | [../guide/first-team.md](../guide/first-team.md), [../guide/admin.md](../guide/admin.md) |
| Runbooks: the convention (one file per alert or operation), the index of written and planned runbooks, the stuck state lock (GWP#52) | [../runbooks/README.md](../runbooks/README.md) |
| Publishing to the public twin: the allowlist and keep-list, the `ci.yml` template, the pre-tag checklist, the publish secrets under `getworkdone/publish/` and what to do when a run fails (GWP#11) | [../publishing.md](../publishing.md), the owner steps for publishing (the maintainers' deploy notes, private) |
| Quality guards: the gate-parity test (ci.yml, README.md "Gates" and CLAUDE.md "Gates" against `.pattern-config.json` `gate_commands`), the no-real-values scan over the published paths with credential shapes, one e2e retry in CI, and the SPA component tests under jsdom (GWP#59); the parity test also fails on a gate CLAUDE.md quotes that the config does not list, and the scan skips a host followed by `(` only in `.ts` files (GWP#137) | `tests/scripts/gate-parity.test.ts`, `tests/scripts/no-real-values.test.ts`, `playwright.config.ts`, `vitest.config.ts`, [../known-issues/2026-10-21-safe-pattern-bypasses.md](../known-issues/2026-10-21-safe-pattern-bypasses.md) "Builder errors on the wrong field" |
| How contributors work and stay in sync | `foolswithtools/prebutton` `docs/working-on-the-program.md` |
| Tracker (pinned issue) | https://github.com/foolswithtools/prebutton/issues/5 |

## Decisions

Decisions live only in the program's register (spec §9.4) and are cited here by number, never copied. The ones this repo is built on: D-021 and D-080 (branch protection), D-026 (stack), D-027 (OpenTelemetry through the Alloy sidecar), D-028 (work types defined structurally, no LLM), D-033 (first request-4-change dispatch target), D-034 (P3, P4, P6), D-035 (no account identifiers in the tree), D-040 (Cognito as the sandbox identity provider; code stays issuer-agnostic), D-041 (sandbox email is SES in sandbox mode), D-042 (the owner's free-tier Grafana Cloud stack; OnCall pages a team mirroring the CODEOWNERS), D-044 (logs as OTel log records), D-048 (output `none` clears captured data at completion and keeps the audit trail), D-088 (the Node 24 LTS line, pinned together, with `engine-strict`), D-022, D-024, D-036, D-052 and D-091 (publishing by tag to the public twin, its credential-free `ci.yml`, and the publish secrets in Secrets Manager).

A new decision is proposed as the next row of the register, in a small PR to `foolswithtools/prebutton` (working-on-the-program.md, "Decisions"). Register rows take the form:

| ID | Decision | Date | Rationale | Source |
|---|---|---|---|---|
| D-NNN | (stub: the next free number in §9.4) | YYYY-MM-DD | | |

## Slice status

<!-- state-sync:begin -->
<!-- Generated from docs/ROADMAP.md by scripts/state-sync.ts; edit the roadmap, not this block. -->
| Slice | Status |
|---|---|
| [#1](https://github.com/foolswithtools/GetWorkDone-private/issues/1) | done |
| [#2](https://github.com/foolswithtools/GetWorkDone-private/issues/2) | done |
| [#3](https://github.com/foolswithtools/GetWorkDone-private/issues/3) | done |
| [#4](https://github.com/foolswithtools/GetWorkDone-private/issues/4) | done |
| [#5](https://github.com/foolswithtools/GetWorkDone-private/issues/5) | done |
| [#6](https://github.com/foolswithtools/GetWorkDone-private/issues/6) | done |
| [#7](https://github.com/foolswithtools/GetWorkDone-private/issues/7) | done |
| [#8](https://github.com/foolswithtools/GetWorkDone-private/issues/8) | done |
| [#9](https://github.com/foolswithtools/GetWorkDone-private/issues/9) | done |
| [#10](https://github.com/foolswithtools/GetWorkDone-private/issues/10) | done |
| [#11](https://github.com/foolswithtools/GetWorkDone-private/issues/11) | done |
| [#12](https://github.com/foolswithtools/GetWorkDone-private/issues/12) | planned |
| [#15](https://github.com/foolswithtools/GetWorkDone-private/issues/15) | done |
| [#16](https://github.com/foolswithtools/GetWorkDone-private/issues/16) | done |
| [#20](https://github.com/foolswithtools/GetWorkDone-private/issues/20) | done |
| [#21](https://github.com/foolswithtools/GetWorkDone-private/issues/21) | done |
| [#22](https://github.com/foolswithtools/GetWorkDone-private/issues/22) | done |
| [#23](https://github.com/foolswithtools/GetWorkDone-private/issues/23) | done |
| [#25](https://github.com/foolswithtools/GetWorkDone-private/issues/25) | done |
| [#26](https://github.com/foolswithtools/GetWorkDone-private/issues/26) | done |
| [#30](https://github.com/foolswithtools/GetWorkDone-private/issues/30) | done |
| [#32](https://github.com/foolswithtools/GetWorkDone-private/issues/32) | done |
| [#35](https://github.com/foolswithtools/GetWorkDone-private/issues/35) | done |
| [#43](https://github.com/foolswithtools/GetWorkDone-private/issues/43) | done |
| [#45](https://github.com/foolswithtools/GetWorkDone-private/issues/45) | done |
| [#17](https://github.com/foolswithtools/GetWorkDone-private/issues/17) | done |
| [#46](https://github.com/foolswithtools/GetWorkDone-private/issues/46) | done |
| [#47](https://github.com/foolswithtools/GetWorkDone-private/issues/47) | done |
| [#48](https://github.com/foolswithtools/GetWorkDone-private/issues/48) | done |
| [#49](https://github.com/foolswithtools/GetWorkDone-private/issues/49) | done |
| [#50](https://github.com/foolswithtools/GetWorkDone-private/issues/50) | done |
| [#51](https://github.com/foolswithtools/GetWorkDone-private/issues/51) | done |
| [#52](https://github.com/foolswithtools/GetWorkDone-private/issues/52) | done |
| [#75](https://github.com/foolswithtools/GetWorkDone-private/issues/75) | done |
| [#66](https://github.com/foolswithtools/GetWorkDone-private/issues/66) | done |
| [#81](https://github.com/foolswithtools/GetWorkDone-private/issues/81) | done |
| [#74](https://github.com/foolswithtools/GetWorkDone-private/issues/74) | done |
| [#54](https://github.com/foolswithtools/GetWorkDone-private/issues/54) | done |
| [#53](https://github.com/foolswithtools/GetWorkDone-private/issues/53) | done |
| [#88](https://github.com/foolswithtools/GetWorkDone-private/issues/88) | done |
| [#89](https://github.com/foolswithtools/GetWorkDone-private/issues/89) | done |
| [#92](https://github.com/foolswithtools/GetWorkDone-private/issues/92) | done |
| [#95](https://github.com/foolswithtools/GetWorkDone-private/issues/95) | done |
| [#105](https://github.com/foolswithtools/GetWorkDone-private/issues/105) | done |
| [#107](https://github.com/foolswithtools/GetWorkDone-private/issues/107) | done |
| [#85](https://github.com/foolswithtools/GetWorkDone-private/issues/85) | done |
| [#109](https://github.com/foolswithtools/GetWorkDone-private/issues/109) | done |
| [#55](https://github.com/foolswithtools/GetWorkDone-private/issues/55) | done |
| [#112](https://github.com/foolswithtools/GetWorkDone-private/issues/112) | done |
| [#57](https://github.com/foolswithtools/GetWorkDone-private/issues/57) | done |
| [#114](https://github.com/foolswithtools/GetWorkDone-private/issues/114) | done |
| [#86](https://github.com/foolswithtools/GetWorkDone-private/issues/86) | done |
| [#116](https://github.com/foolswithtools/GetWorkDone-private/issues/116) | done |
| [#121](https://github.com/foolswithtools/GetWorkDone-private/issues/121) | done |
| [#101](https://github.com/foolswithtools/GetWorkDone-private/issues/101) | done |
| [#120](https://github.com/foolswithtools/GetWorkDone-private/issues/120) | done |
| [#102](https://github.com/foolswithtools/GetWorkDone-private/issues/102) | done |
| [#98](https://github.com/foolswithtools/GetWorkDone-private/issues/98) | done |
| [#59](https://github.com/foolswithtools/GetWorkDone-private/issues/59) | done |
| [#137](https://github.com/foolswithtools/GetWorkDone-private/issues/137) | done |
| [#133](https://github.com/foolswithtools/GetWorkDone-private/issues/133) | done |
| [#60](https://github.com/foolswithtools/GetWorkDone-private/issues/60) | done |
| [#145](https://github.com/foolswithtools/GetWorkDone-private/issues/145) | done |
| [#78](https://github.com/foolswithtools/GetWorkDone-private/issues/78) | done |
| [#100](https://github.com/foolswithtools/GetWorkDone-private/issues/100) | done |
| [#70](https://github.com/foolswithtools/GetWorkDone-private/issues/70) | done |
| [#56](https://github.com/foolswithtools/GetWorkDone-private/issues/56) | done |
| [#127](https://github.com/foolswithtools/GetWorkDone-private/issues/127) | done |
| [#99](https://github.com/foolswithtools/GetWorkDone-private/issues/99) | done |
| [#58](https://github.com/foolswithtools/GetWorkDone-private/issues/58) | done |
| [#139](https://github.com/foolswithtools/GetWorkDone-private/issues/139) | done |
| [#149](https://github.com/foolswithtools/GetWorkDone-private/issues/149) | done |
| [#72](https://github.com/foolswithtools/GetWorkDone-private/issues/72) | done |
| [#143](https://github.com/foolswithtools/GetWorkDone-private/issues/143) | done |
| [#134](https://github.com/foolswithtools/GetWorkDone-private/issues/134) | done |
| [#151](https://github.com/foolswithtools/GetWorkDone-private/issues/151) | done |
| [#157](https://github.com/foolswithtools/GetWorkDone-private/issues/157) | done |
| [#154](https://github.com/foolswithtools/GetWorkDone-private/issues/154) | done |
| [#158](https://github.com/foolswithtools/GetWorkDone-private/issues/158) | done |
| [#103](https://github.com/foolswithtools/GetWorkDone-private/issues/103) | done |
| [#165](https://github.com/foolswithtools/GetWorkDone-private/issues/165) | done |
| [#169](https://github.com/foolswithtools/GetWorkDone-private/issues/169) | done |
| [#172](https://github.com/foolswithtools/GetWorkDone-private/issues/172) | done |
| [#130](https://github.com/foolswithtools/GetWorkDone-private/issues/130) | planned |
<!-- state-sync:end -->

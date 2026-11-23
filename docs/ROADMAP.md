# Roadmap

Status markers: planned / in-progress / done. Update at close-out, in the same PR as the change; then run `pnpm exec tsx scripts/state-sync.ts` to refresh the status block in [context/STATE.md](context/STATE.md) (`pnpm lint` fails until you do). Cross-repo order and dependencies live in the tracker, foolswithtools/prebutton#5.

| Issue | Slice | Status |
|---|---|---|
| [#1](https://github.com/foolswithtools/GetWorkDone-private/issues/1) | chore(bootstrap): scaffold GetWorkDone-private monorepo with the ported telemetry package and CI gate order | done |
| [#2](https://github.com/foolswithtools/GetWorkDone-private/issues/2) | feat(model): add teams, work types, schemas, steps, items and outputs | done |
| [#3](https://github.com/foolswithtools/GetWorkDone-private/issues/3) | feat(auth): add OIDC sign-in behind an identity interface | done |
| [#4](https://github.com/foolswithtools/GetWorkDone-private/issues/4) | feat(capture): add the schema builder and validated capture | done |
| [#5](https://github.com/foolswithtools/GetWorkDone-private/issues/5) | feat(process): run ordered human and automated steps | done |
| [#6](https://github.com/foolswithtools/GetWorkDone-private/issues/6) | feat(distribute): add email, webhook and export outputs with timeouts and idempotency | done |
| [#7](https://github.com/foolswithtools/GetWorkDone-private/issues/7) | feat(observability): add SLOs, burn-rate alerts, OnCall routing and automated manifest status | done |
| [#8](https://github.com/foolswithtools/GetWorkDone-private/issues/8) | infra(deploy): deploy the GetWorkDone app stage to getworkdone-dev and promote one digest to getworkdone | done |
| [#9](https://github.com/foolswithtools/GetWorkDone-private/issues/9) | test(smoke): add k6 smoke, live verification and alert fault injection | done |
| [#10](https://github.com/foolswithtools/GetWorkDone-private/issues/10) | feat(r4c): host the request-4-change edge sidecar with path route, CSS tokens and auth passthrough | done |
| [#11](https://github.com/foolswithtools/GetWorkDone-private/issues/11) | infra(publish): open tagged code snapshots with credential-free CI as PRs on public GetWorkDone | done |
| [#12](https://github.com/foolswithtools/GetWorkDone-private/issues/12) | infra(deploy): deploy GetWorkDone feature-branch preview instances with the TTL lifecycle | planned |
| [#15](https://github.com/foolswithtools/GetWorkDone-private/issues/15) | fix(api): keep double-slash /api paths off the SPA fallback | done |
| [#16](https://github.com/foolswithtools/GetWorkDone-private/issues/16) | feat(auth): purge expired sessions and sign-ins and rate-limit /auth/login | done |
| [#20](https://github.com/foolswithtools/GetWorkDone-private/issues/20) | feat(teams): add and remove team members | done |
| [#21](https://github.com/foolswithtools/GetWorkDone-private/issues/21) | fix(capture): align definition error responses and tidy capture follow-ups | done |
| [#22](https://github.com/foolswithtools/GetWorkDone-private/issues/22) | feat(process): resume an item whose processing stopped between transitions | done |
| [#23](https://github.com/foolswithtools/GetWorkDone-private/issues/23) | feat(process): let an admin correct a failed item's data before a retry | done |
| [#25](https://github.com/foolswithtools/GetWorkDone-private/issues/25) | feat(distribute): limit and expire stored exports | done |
| [#26](https://github.com/foolswithtools/GetWorkDone-private/issues/26) | fix(test): keep the e2e delivery worker off rows the integration run left pending | done |
| [#30](https://github.com/foolswithtools/GetWorkDone-private/issues/30) | fix(api): keep encoded, dot-segment and backslash /api paths off the SPA fallback | done |
| [#32](https://github.com/foolswithtools/GetWorkDone-private/issues/32) | feat(auth): count the /auth/login rate limit across API tasks | done |
| [#35](https://github.com/foolswithtools/GetWorkDone-private/issues/35) | feat(web): hold the export button for the Retry-After seconds after a 429 | done |
| [#43](https://github.com/foolswithtools/GetWorkDone-private/issues/43) | infra(deploy): add the sandbox bootstrap, data stages and deploy workflow for getworkdone and getworkdone-dev | done |
| [#45](https://github.com/foolswithtools/GetWorkDone-private/issues/45) | fix(deploy): allow the profile scope on the Cognito app client | done |
| [#17](https://github.com/foolswithtools/GetWorkDone-private/issues/17) | feat(auth): give the sign-in cookies the __Host- prefix | done |
| [#46](https://github.com/foolswithtools/GetWorkDone-private/issues/46) | chore(runtime): move to Node 24 and enforce the engines range locally | done |
| [#47](https://github.com/foolswithtools/GetWorkDone-private/issues/47) | feat(web): base stylesheet and theme tokens | done |
| [#48](https://github.com/foolswithtools/GetWorkDone-private/issues/48) | feat(api): security response headers with a CSP that admits the r4c widget | done |
| [#49](https://github.com/foolswithtools/GetWorkDone-private/issues/49) | feat(teams): create a team from the SPA and show the signed-in subject | done |
| [#50](https://github.com/foolswithtools/GetWorkDone-private/issues/50) | feat(api): bound outputs per definition and add per-subject quotas | done |
| [#51](https://github.com/foolswithtools/GetWorkDone-private/issues/51) | infra(ci): dependency and image vulnerability gates | done |
| [#52](https://github.com/foolswithtools/GetWorkDone-private/issues/52) | docs(guide): first-team guide and operator runbook index | done |
| [#75](https://github.com/foolswithtools/GetWorkDone-private/issues/75) | fix(deploy): let the deploy role describe KMS keys so RDS can use its default key | done |
| [#66](https://github.com/foolswithtools/GetWorkDone-private/issues/66) | infra(db): keep the API connecting after RDS rotates the master password | done |
| [#81](https://github.com/foolswithtools/GetWorkDone-private/issues/81) | fix(drill): find the OnCall alert group without the undocumented state=firing filter | done |
| [#74](https://github.com/foolswithtools/GetWorkDone-private/issues/74) | fix(distribute): keep a delivery's attempt when the quota take fails, and share the worker's clock | done |
| [#54](https://github.com/foolswithtools/GetWorkDone-private/issues/54) | feat(process): cancel an item, record a decision on a human step, and filter items by status | done |
| [#53](https://github.com/foolswithtools/GetWorkDone-private/issues/53) | feat(observability): pipeline heartbeat, delivery failure alert and readiness signals | done |
| [#88](https://github.com/foolswithtools/GetWorkDone-private/issues/88) | infra(publish): run the snapshot's gitleaks scan in a job without the OIDC token | done |
| [#89](https://github.com/foolswithtools/GetWorkDone-private/issues/89) | docs(publish): no published doc links an unpublished path | done |
| [#92](https://github.com/foolswithtools/GetWorkDone-private/issues/92) | infra(publish): refuse a .gitleaksignore in the staged tree before the gitleaks scan | done |
| [#95](https://github.com/foolswithtools/GetWorkDone-private/issues/95) | feat(deploy): create the empty r4c-signing-key secret in the data stage (prerequisite for #10) | done |
| [#105](https://github.com/foolswithtools/GetWorkDone-private/issues/105) | fix(test): keep the r4c live spec's waits inside the CSP and stop it waiting on its own outcome promise | done |
| [#107](https://github.com/foolswithtools/GetWorkDone-private/issues/107) | fix(r4c): pin an edge image whose widget adopts its stylesheet, so it is styled under style-src 'self' | done |
| [#85](https://github.com/foolswithtools/GetWorkDone-private/issues/85) | feat(deploy): pause the getworkdone-dev alert rules when destroy.yml destroys dev | done |
| [#109](https://github.com/foolswithtools/GetWorkDone-private/issues/109) | fix(deploy): let the running-digests check wait as long as a task rollout takes | done |
| [#55](https://github.com/foolswithtools/GetWorkDone-private/issues/55) | feat(process): the waiting-for-me queue, work-type archive and the stuck-item sweeper | done |
| [#112](https://github.com/foolswithtools/GetWorkDone-private/issues/112) | fix(deploy): unpause the getworkdone-dev alert rules once deploy.yml applies the app stage, even when app-dev then fails | done |
| [#57](https://github.com/foolswithtools/GetWorkDone-private/issues/57) | infra(db): a least-privilege database role for the API and verified TLS to RDS | done |
| [#114](https://github.com/foolswithtools/GetWorkDone-private/issues/114) | fix(deploy): warn or unpause the getworkdone-dev rules when app-dev is cancelled, or fails inside the app stage, after dev came back | done |
| [#86](https://github.com/foolswithtools/GetWorkDone-private/issues/86) | feat(telemetry): give each API task its own metric series, and reuse an outstanding backlog count | done |
| [#116](https://github.com/foolswithtools/GetWorkDone-private/issues/116) | fix(observability): make session purge stalled sum across API tasks | done |
| [#121](https://github.com/foolswithtools/GetWorkDone-private/issues/121) | infra(db): revoke PUBLIC's TEMPORARY and function EXECUTE from the API's database role | done |
| [#101](https://github.com/foolswithtools/GetWorkDone-private/issues/101) | fix(distribute): keep the delivery worker quiet until the database schema exists on a fresh instance | done |
| [#120](https://github.com/foolswithtools/GetWorkDone-private/issues/120) | docs(deploy): put db-app from a file, silence alerts for the role rollout, and list db-app under Destroy | done |
| [#102](https://github.com/foolswithtools/GetWorkDone-private/issues/102) | feat(process): back off a stuck item the sweeper cannot advance, so it never blocks the batch | done |
| [#98](https://github.com/foolswithtools/GetWorkDone-private/issues/98) | feat(web): give every SPA view its own URL, so reload, back and forward and deep links work | done |
| [#59](https://github.com/foolswithtools/GetWorkDone-private/issues/59) | chore(quality): CI-to-config parity test, README gate list, roadmap title, hygiene scan scope, e2e retries and the builder regression test | done |
| [#137](https://github.com/foolswithtools/GetWorkDone-private/issues/137) | chore(quality): catch an extra gate in CLAUDE.md and narrow the no-real-values call skip | done |
| [#133](https://github.com/foolswithtools/GetWorkDone-private/issues/133) | fix(test): keep the e2e suite under the /auth/login rate limit, so sign-in.spec.ts does not fail on a fast runner | done |
| [#60](https://github.com/foolswithtools/GetWorkDone-private/issues/60) | docs(deploy): set the name attribute when the owner adds Cognito users | done |
| [#145](https://github.com/foolswithtools/GetWorkDone-private/issues/145) | fix(test): write the webhook secret before the schema-ready test's delivery, so the worker cannot claim it first | done |
| [#78](https://github.com/foolswithtools/GetWorkDone-private/issues/78) | infra(ci): let Renovate move the Node patch in README.md, .nvmrc and the Dockerfile together | done |
| [#100](https://github.com/foolswithtools/GetWorkDone-private/issues/100) | infra(ci): run the built API image's prisma migrate deploy against the CI Postgres | done |
| [#70](https://github.com/foolswithtools/GetWorkDone-private/issues/70) | test(e2e): follow the first-team guide's steps 4 to 8 end to end and check doc section anchors | done |
| [#56](https://github.com/foolswithtools/GetWorkDone-private/issues/56) | feat(auth): end prior sessions on sign-in, sign out everywhere, and Cognito MFA | done |
| [#127](https://github.com/foolswithtools/GetWorkDone-private/issues/127) | fix(process): make the stuck-item sweeper wait for the sweep_backoff columns, not only the status index | done |
| [#99](https://github.com/foolswithtools/GetWorkDone-private/issues/99) | feat(teams): show members by display name and email, not only by identity-provider subject | done |
| [#58](https://github.com/foolswithtools/GetWorkDone-private/issues/58) | feat(observability): tuning follow-ups: log and trace volume, stdout fields, dashboard per SLO | done |
| [#139](https://github.com/foolswithtools/GetWorkDone-private/issues/139) | chore(quality): check every CI job for gates, narrow the no-real-values call skip to known calls, correct the allowlist comment | done |
| [#149](https://github.com/foolswithtools/GetWorkDone-private/issues/149) | chore(quality): fail the gate parity test when a gate job needs a job that may be skipped | done |
| [#72](https://github.com/foolswithtools/GetWorkDone-private/issues/72) | fix(observability): confirm the CloudWatch labels, age the drill result, read the stage's names | done |
| [#143](https://github.com/foolswithtools/GetWorkDone-private/issues/143) | feat(auth): a retention rule for Identity profiles, so a person's email and name are not kept forever | done |
| [#134](https://github.com/foolswithtools/GetWorkDone-private/issues/134) | fix(observability): follow-ups from #132 review (LOG_STDOUT_LEVEL parsing, Terraform input, quota startup line) | done |
| [#151](https://github.com/foolswithtools/GetWorkDone-private/issues/151) | fix(test): create the schema-ready test's role and its grants in one transaction, so a job cannot start between them | done |
| [#157](https://github.com/foolswithtools/GetWorkDone-private/issues/157) | feat(db): add a partial index for the stuck-item sweeper's scan (expand) | done |
| [#154](https://github.com/foolswithtools/GetWorkDone-private/issues/154) | feat(observability): count deleted quota windows in session_purge_rows_deleted_total | done |
| [#158](https://github.com/foolswithtools/GetWorkDone-private/issues/158) | feat(db): drop the stuck-item sweeper's old status index (contract) | done |
| [#103](https://github.com/foolswithtools/GetWorkDone-private/issues/103) | fix(work-types): archived work types do not count against QUOTA_WORK_TYPES_PER_TEAM | done |
| [#165](https://github.com/foolswithtools/GetWorkDone-private/issues/165) | fix(test): let the unit partition pass on macOS (bash 3.2 in image-migrate-check.sh, BSD sha256sum in the publish compare tests) | done |
| [#169](https://github.com/foolswithtools/GetWorkDone-private/issues/169) | fix(deploy): scope the deploy role's rds! master-secret grants to GetWorkDone and drop RotateSecret | done |
| [#172](https://github.com/foolswithtools/GetWorkDone-private/issues/172) | fix(deps): override @prisma/config's pinned effect to 3.22.1 for GHSA-7589-6fvf-x4pw | done |
| [#130](https://github.com/foolswithtools/GetWorkDone-private/issues/130) | feat(deploy): require TOTP MFA on the sandbox user pools, with k6 answering the code prompt | planned |

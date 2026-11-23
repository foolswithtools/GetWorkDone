# applyAlerting replaced the shared stack's whole notification policy tree, deleting the fleet's route

Resolved in GWP#171. GetWorkDone's Grafana Cloud stack is shared with the fleet, which keeps its `fleet-loup` folder, its `fleet-loup-*` rules, a `fleet-loup-ops` contact point and a top-level route `service="loup"` → `fleet-loup-ops` there. `applyAlerting` (observability/alerting/apply.ts) PUT `notificationPolicy()` as the whole tree, and a `PUT` of the policy tree through the alerting provisioning API replaces the tree. Every `apply.ts` run therefore deleted any route this repo did not define and set the root receiver to `getworkdone-oncall`. `docs/observability.md` stated the design ("the stack's policy tree is owned by this code"), and it held only while GetWorkDone was the stack's sole tenant.

It happened between 2026-10-30 19:55Z and 2026-10-31 01:59Z: the stack's notification history shows the last delivery to `fleet-loup-ops` at 19:55:34Z and the first to `getworkdone-oncall` at 01:59:24Z, and every delivery after that went to `getworkdone-oncall`. On 2026-11-02 the fleet's `Creature down (scrape failing)` and `Loop frozen while awake` fired at 23:48Z and went to GetWorkDone's OnCall, not the fleet's ops channel. Because the root receiver was OnCall, any alert on the stack that no route matched paged GetWorkDone too. The fleet restored its route on 2026-11-11 with its own read-modify-write, and a deploy on 2026-11-22 deleted it again: that day's live tree was the root `getworkdone-oncall` and the `team=getworkdone` route only.

Fix (the issue's option 1, read-modify-write): `mergePolicy` (observability/alerting/definitions.ts) merges the one route this code owns into the tree `apply.ts` reads, and the reconcile's `desired` is that merge, so a merged tree gets no PUT.
- A route is owned when it is top-level and its `object_matchers` are exactly `team=getworkdone`, with no legacy `matchers`, `match` or `match_re`. A route that also matches another label is foreign.
- The owned route replaces the first owned route in place, and a later copy is dropped. When there is none, it is appended. Every other route, every nested route and every root field pass through in order. The fleet's own merge puts its route first and passes the rest through, so the two converge rather than reorder each other.
- The root receiver is set to `getworkdone-oncall` only while it is the stack default (`grafana-default-email` or empty). Any other root receiver is kept and reported, `getworkdone-oncall` included while the tree holds another tenant's routes. `provenance` is not sent back.

Restoring the fleet's route on the live stack is a write to the shared stack, done by the owner or the fleet after this fix is deployed; it is not part of the fix. Until the fleet's route is back, the stack's root stays `getworkdone-oncall` (each `apply.ts` run now reports it: `notification-policy root: receiver getworkdone-oncall is not the stack default, left as is; …`), so an alert no route matches still pages GetWorkDone.

Regression tests, in `observability/test/apply.test.ts`, describe block "apply.ts on a shared stack: the notification policy is read, merged and written back (GWP#171)":
- "keeps a foreign route in order and a foreign root receiver, and adds exactly one team=getworkdone route"
- "replaces a stale team=getworkdone route in place, not duplicated, and drops a second copy"
- "treats a route matching team=getworkdone and another label, or with legacy matchers, as foreign"
- "a stack whose tree is already merged gets no policy PUT"
- "sets a default (grafana-default-email) or empty root receiver to getworkdone-oncall and keeps foreign routes"
- "keeps a getworkdone-oncall root on a shared tree and reports that it catches other tenants' unmatched alerts"
- "sends back the root timings and nested routes it read, without the provenance field"

and, in `observability/test/definitions.test.ts`, "mergePolicy of an empty tree is notificationPolicy() bar the root group_by, and merging a merged tree changes nothing (GWP#171)" and "isOwnedRoute owns exactly the team=getworkdone route, with no other or legacy matcher". The first six apply tests failed on `main` at 684c73d and pass with the fix. The seventh was added in review and failed on the first version of the fix, which said nothing about a `getworkdone-oncall` root.

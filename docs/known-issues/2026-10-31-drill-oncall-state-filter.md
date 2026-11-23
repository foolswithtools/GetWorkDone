# The alert drill asked OnCall for state=firing and never found the alert group

Resolved in GWP#81. The drill is GWP#9's (`tests/k6/fault-drill.js`). Its OnCall fields were marked "[unverified until the first drill]", and the first drill showed this one was wrong. Nothing was exposed. The fired alert most likely opened an OnCall alert group that the drill did not resolve.

The first dispatch of `alert-drill.yml` (run 41157750000, `main` at 2bb1a8c, 2026-10-31) set the latency fault, sent 300 drill requests and saw `getworkdone-dev-api-latency fast burn` reach `Firing`. It then timed out after 300 s waiting for an OnCall alert group, wrote no `drill-result` line, and the job's record step failed. Every deploy's `Live coverage` kept failing `alert-fault-injection` ("no drill result yet").

The lookup listed `alert_groups/?integration_id=<id>&state=firing`. OnCall's Alert groups HTTP API documents the `state` filter as `new`, `acknowledged`, `resolved` or `silenced`; there is no `firing`. The lookup returned `undefined` on any non-200 without logging it, so each refused request read as "no group yet". k6 counted 20 failed requests out of 345, one per 15-second poll over the 300 s wait. That every poll was refused is inferred from that count, not observed: the log did not record the status. The integration lookup with the same headers succeeded, so the token and URL were right.

Why no test caught it: the drill runs only live, and nothing exercised its request or its matching.

Fix: the lookup moved to `tests/k6/lib/oncall.js` (no k6 import). It requests the integration's alert groups with no `state` filter and picks the first group that is not `resolved` and whose `alertname` label or title names the rule. A group the owner acknowledges from the page still counts. A non-200 answer is now logged with its status and the start of its body (`OnCall alert_groups answered <status>: ...`).

Regression tests:

- `tests/k6/oncall.test.ts` (partition: unit), runs "the alert-groups request names the integration and no state filter" and "a group for another rule, or a resolved one, is not picked". Both failed against the old lookup.
- The live check is the next drill: green, with a `drill-result` naming both alert groups (`docs/runbooks/alert-drill.md`).

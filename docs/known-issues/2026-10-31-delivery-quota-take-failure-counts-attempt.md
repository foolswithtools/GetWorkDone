# A failed delivery quota take cost the row an attempt, and the quota clock ignored the distribute clock

Resolved in GWP#74, found by the whole-branch review of GWP#50 (PR #73). No occurrence was observed; the defect was found by reading the code.

**Lost attempt.** The delivery worker claims a row (`attempts + 1`, a 60 s lease) and then takes the team's `deliveries` quota (`apps/api/src/modules/distribute/delivery.worker.ts`, `deferred`). If the take threw (Postgres unreachable for a moment), the lane logged the error and the row kept its claimed attempt with nothing sent. Three such claims in a row and the next claim ended the row `failed` with reason `interrupted`: an item lost a delivery it never attempted. `docs/outputs.md` "Retry policy" described this as intended.

Fix: when the take throws, the worker reverts the attempt with the same guarded write as a deferral (`WHERE id AND status = 'pending' AND attempts = $claimed`, `attempts - 1`), keeps the lease as `nextAttemptAt`, logs `delivery quota take failed; attempt reverted`, and moves on. If that write fails too, the lane logs it and the row waits out its lease as before. The quota store and the revert share one database, so a full outage still counts the claim; the fix covers a take that fails alone (a lock or serialization error on the `QuotaWindow` upsert, a dropped connection, or a separate quota store).

**Quota clock.** `QuotaOptions.now` fell back to real time, not to `distribute.now`, so a test that faked only the distribute clock ahead of real time and set quota limits got deferrals timed from real time: the deferred row was due again at once and `runOnce` claimed and deferred it in a loop. Production has one real clock, so this was a test-harness hazard only. Fix: `quotaLimiter` takes the distribute clock as a fallback (`CommonModule.forRoot(quotas, distribute?.now)`); the distribute clock alone does not turn quotas on.

Why no test caught it: the GWP#50 tests used a store that never fails and passed both clocks explicitly.

Regression tests:

- `apps/api/test/quotas.integration.test.ts` (partition: integration), "a quota take that throws reverts the claim's attempt and keeps the lease; three in a row never end the row interrupted (GWP#74)". It failed at claim 1 (`attempts` 1) before the fix.
- `apps/api/test/quotas.integration.test.ts` no longer passes `quotas.now`, so "the third item in a minute ..." and "a team past its delivery quota has the rest deferred ..." run on the defaulted clock; both failed before the fix.
- `apps/api/test/quota.test.ts` (partition: unit), "given only a distribute clock, uses it for window ends: the refusal is timed from that clock", with two guards: the quotas clock wins, and the distribute clock alone enforces nothing.

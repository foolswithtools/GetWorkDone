# The e2e suite went over the /auth/login rate limit on a fast runner

Resolved in GWP#133. Found on PR #132 (GWP#58): CI run 41490700081 failed only at `tests/e2e/sign-in.spec.ts:30`, waiting for `signed-in-as`, in a spec that PR does not touch.

Every e2e spec starts its API with `tests/e2e/support/api-server.ts`, and every spec signs in from 127.0.0.1 against the run's one scratch database. `/auth/login` allows `LOGIN_RATE_LIMIT` sign-ins a minute per client address (20 by default), counted in Postgres across API processes ([../auth.md](../auth.md)), so the whole suite shared one budget of 20 a minute. In that run the outputs, process, r4c and routing specs started about 24 sign-ins in 19 s, and the next sign-in, sign-in.spec.ts's, was answered 429 (inferred: the run kept no trace). `main`'s green run 41374832820 ran the same block about 7 s slower and stayed under the limit, so the gate passed or failed by runner speed; #98's routing spec had added the sign-ins that brought it close.

Reproduced locally: `pnpm exec playwright test tests/e2e/sign-in.spec.ts --repeat-each 15` failed 3 of 15, from the thirteenth repeat, and the failing repeat's trace shows `/auth/login` answering 429.

Fix: `api-server.ts` sets `LOGIN_RATE_LIMIT=1000` in the API's environment, as it already raises `QUOTA_ITEMS_PER_SUBJECT_PER_MINUTE`. The API's default and the limit's logic are unchanged; the limit itself stays covered at its default, 20, by `apps/api/test/auth.integration.test.ts` "GET /auth/login rate limit".

Regression test: `tests/e2e/sign-in.spec.ts` "sign in, see the team list, sign out", which passes 15 of 15 with `--repeat-each 15`, and the full `pnpm e2e` in CI.

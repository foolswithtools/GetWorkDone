# The schema-ready test's delivery could be claimed before its webhook secret existed

Resolved in GWP#145. Found by CI run 41540975683 on PR #144 (GWP#99); the failure was not in that change. Test-only: no production code changed.

`apps/api/test/schema-ready.integration.test.ts` (GWP#101) seeded a due pending webhook delivery with `seedPendingDelivery` (`apps/api/test/support/scratch-database.ts`) and only then wrote the output's `OutputSecret`. The API's delivery worker polls every 100 ms in that test, so it could claim the row between the two writes. The webhook adapter refuses a config without a secret, so that attempt ended the row `failed` after 1 attempt and the test's 20 s wait for `delivered` timed out. A 500 ms pause after the seed made both variants (as the database owner, and as the role the migrate task creates) fail every time.

Fix: `seedPendingDelivery` takes an optional `webhookSecret` and writes the `OutputSecret` in the same transaction as the seed, before the `Delivery` row, so the row is never visible to the worker without its secret. The schema-ready test passes it and no longer writes the secret itself. The worker's handling of a missing secret is unchanged (out of scope).

Regression test:

- `apps/api/test/schema-ready.integration.test.ts` (partition: integration), "logs one warn per job and no error while the schema is missing, then starts every job once migrated and sends a due delivery", both variants. With a 500 ms pause added after the seed they timed out before the fix and passed after it; the pause was then removed.

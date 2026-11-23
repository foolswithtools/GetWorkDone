# The e2e delivery worker sent rows the integration run left pending

Resolved in GWP#26, a follow-up from the GWP#6 whole-branch review. Nothing failed; the e2e run made outbound DNS lookups no test asked for and changed another suite's data.

CI runs the integration partition and then the e2e partition against one Postgres. Two tests in `apps/api/test/delivery.integration.test.ts` ("a human step: ..." and "a non-member cannot read ...") completed items with a webhook output aimed at `https://receiver.test` and never ran the worker, so their rows stayed `pending`. Every API an e2e spec starts runs in production mode, and its worker claims every due `pending` row in the database. It resolved `receiver.test` over real DNS, recorded `dns_error` and counted an attempt; after three e2e runs on one database it would have ended the rows `failed` and written `delivery_failed` onto the integration run's items.

`DELIVERY_POLL_MS`, which the issue offered as one fix, only sets the poll period. The worker also runs at boot and on every completion, so no value of it keeps the worker to the e2e run's rows, and the claim query is out of scope.

Fix:

- The two tests now run the worker until their rows are `delivered`.
- The e2e partition runs on its own database. `tests/e2e/support/global-setup.ts` creates and migrates a scratch database beside the one at `DATABASE_URL` and drops it after the run (`docs/outputs.md`, "Test isolation").

Regression tests:

- `apps/api/test/delivery.integration.test.ts`, "leaves no Delivery row of this run pending" (the file's last test).
- `tests/e2e/isolation.spec.ts`, "the e2e worker sends its own database's due rows and leaves the integration database's alone".

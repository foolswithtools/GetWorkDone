# Two exports in one team could deadlock, and a large one could time out storing

Resolved before merge, GWP#25. Found by the fresh-context whole-branch review.

The first version of GWP#25 stored an export in a Prisma interactive transaction that locked the work type's row, then trimmed the work type to 10 and deleted the team's exports older than 7 days. Two defects:

- **Deadlock.** The 7-day delete is team-wide, but the lock covered only one work type. Two exports of different work types in one team, at once, each locked its own rows in the trim and then waited for the other's in the 7-day delete. Postgres aborts one of them (P2034), and that member got a 500.
- **Timeout.** The transaction ran with Prisma's defaults: 2 s to start and 5 s in all. A 10 MB insert, or one waiting behind another export's, could pass that and fail with P2028, a 500, where storing without a transaction had succeeded.

Fix: `exports.service.ts` locks the team's row (`FOR NO KEY UPDATE`), so a team's exports are stored one at a time. The transaction runs at READ COMMITTED, which the 30-second check relies on to see the export the lock holder committed, with `maxWait` and `timeout` of 10 s, the same settings `process.service.ts` uses.

Regression test: `apps/api/test/export.integration.test.ts`, "two exports of a work type asked for at once store one". It fails 3 of 3 runs with the lock removed. No test reproduces the deadlock or the timeout deterministically; both are covered by the lock and the explicit transaction settings.

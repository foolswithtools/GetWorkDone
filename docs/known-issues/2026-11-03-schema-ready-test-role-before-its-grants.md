# The schema-ready test's role could sign in before it held its grants

Resolved in GWP#151. Found by `ci` run 41587566767 on PR #132 (merge queue of 2026-11-03); the failure was not in that change. Test-only: no production code changed.

`apps/api/test/schema-ready.integration.test.ts` (GWP#101) runs its second variant as a role that exists only once the migrate task has created it (#57). Its `createRole()` ran `CREATE ROLE ... LOGIN` and then each `GRANT` as separate statements, each committed on its own. A job whose schema-wait check signed in between them found the migrated tables, started, and its first query was refused with `42501`: `session purge failed` with `permission denied for table LoginAttempt` at `error` (`apps/api/src/modules/auth/session-purge.ts`), which the test forbids. The gap was tens of milliseconds, so the case passed almost always; ten local runs of the integration partition on the old shape all passed. A 4 s pause after `CREATE ROLE` made the variant fail every time (3 of 3), with the same error from the session purge, the stuck-item sweeper and the delivery worker.

The sandbox is not affected: `packages/db/sql/app-role.sql` runs inside the migrate task, before any app task starts.

Fix: `createRole()` issues `CREATE ROLE` and every `GRANT` in one `client.$transaction([...])`. Role and grant DDL are transactional in Postgres, so other connections see the role only once it holds its grants. A `42501` from a job's query still logs at error and the schema wait does not retry it (out of scope: a real grant miss on a deployed instance must log at error).

Regression test:

- `apps/api/test/schema-ready.integration.test.ts` (partition: integration), "logs one warn per job and no error while the schema is missing, then starts every job once migrated and sends a due delivery", the "a role the migrate task creates" variant. With a 4 s `pg_sleep` inside the transaction after `CREATE ROLE` it passed 3 of 3, where the same pause between the old separate statements failed 3 of 3; the pause was then removed, and the fixed shape passed ten runs in a row.

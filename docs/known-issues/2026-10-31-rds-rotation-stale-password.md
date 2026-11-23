# A task that outlived an RDS rotation kept the old database password

Resolved in GWP#66 (approach A, the owner's decision on the issue). Found by the fresh-context whole-branch review of #8 and recorded as a residual in `docs/deploy/sandbox.md`; it had not yet bitten, since `prod` went live on 2026-10-30 and its first scheduled rotation falls around 2026-11-06.

The data stage creates the database with `manage_master_user_password = true` (`deploy/sandbox/data/rds.tf`), so RDS keeps the master password in a managed `rds!db-…` secret and rotates it every 7 days by default. The app stage hands that secret to the API as the ECS secret `DATABASE_CREDENTIALS`, which ECS resolves only when a task starts. A task that ran past a rotation kept the old password: its pooled connections survived, but every new connection failed with SQLSTATE `28P01`, so the API would have degraded into 500s, and `/auth/login` into 503s, until the task was replaced. `dev` is replaced on every push to `main`; `prod` only on `promote`.

Why no test caught it: every suite connects with a password that never changes, and the tofu tests pin grants against a mock provider, where nothing rotates.

Fix: the API's pool (`packages/db/src/credentials.ts`, `RereadingPool`) gives each new connection the password it holds, through node-postgres's per-connection `password` function, and on a `28P01` re-reads the secret once (the API's `GetSecretValue` on `DATABASE_CREDENTIALS_SECRET_ARN`, inside a span) and connects again. The app stage passes that ARN as a plain variable and grants the task role `secretsmanager:GetSecretValue` on exactly that secret, inside the boundary's existing `DatabaseSecret` statement, so the bootstrap is unchanged.

Found while building it (resolved before merge): `PrismaPg` ends a pool it was given on `$disconnect` only with `disposeExternalPool: true`, and removes its idle-error listener either way. Without the option the rereading pool's connections outlived the client, and an idle one that the server then closed raised an unhandled `error`, which would end the process. `createPrismaClient` passes the option.

Regression tests:

- `packages/db/src/credentials.test.ts` (unit), "re-reads the secret once when the first connection fails with 28P01, then connects", with the concurrent, no-loop and non-28P01 cases beside it.
- `packages/db/test/credentials.integration.test.ts` (integration), "reconnects with the re-read password after the password changes mid-run": a throwaway role's password is changed and its sessions ended, a client without the re-read fails, and one with it reconnects, through `pool.query` and through a transaction.
- `deploy/sandbox/app/tests/database-secret.tftest.hcl` (the `tofu-test` gate), run "task_role_reads_the_db_app_secret_only" (renamed by #57 from "task_role_reads_the_master_secret_only"): the task role's statement allows `GetSecretValue` on the database secret ECS injects as `DATABASE_CREDENTIALS` and nothing else, and the container's `DATABASE_CREDENTIALS_SECRET_ARN` is that secret. Since #57 it is `getworkdone/<instance>/db-app`, which does not rotate; the master secret is the migrate task's only.
- The same integration file, "closes its connections on $disconnect, as the adapter does with a pool of its own".

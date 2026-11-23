# The migrate task would have trusted the wrong CA, and once would have run nothing

Two defects in #57's branch, both resolved before merge. Neither reached `main`.

**Prisma trusts only the first certificate in `sslcert`.** #57 verifies the migrate task's Prisma CLI with `sslmode=require&sslcert=<file>&sslaccept=strict`. As first built, `<file>` was the committed RDS bundle (`deploy/rds/global-bundle.pem`, 114 roots). Prisma 7.10.1's schema engine adds only the file's first certificate as a trust anchor. The bundle's first is `Amazon RDS sa-east-1 Root CA RSA2048 G1`, so every migrate run against the us-east-1 instance would have failed with P1011 (`unable to get local issuer certificate`). After the first deploy the API would have been left as `getworkdone_app` with no role. The fresh-context whole-branch review (r1) found it against a TLS Postgres: a CA file holding a decoy root and then the right one fails, and the right one and then a decoy passes. pg (`pg-connection-string`) reads the whole file, so the API was never affected.

Why no test caught it: CI's Postgres has no TLS, and the unit tests compare URL strings.

Fix: the image also carries the one root of the instance's CA, `deploy/rds/rds-ca-rsa2048-g1-us-east-1.pem`, as `/app/rds-ca-prisma.pem`. The app stage sets `DATABASE_PRISMA_SSL_CERT` to it, and the data stage pins `ca_cert_identifier = "rds-ca-rsa2048-g1"` to match (`deploy/rds/README.md`).

**The migrate task's entry guard never fired in the image.** `packages/db/src/migrate-task.ts` ran its `main` only when `import.meta.url` equalled `pathToFileURL(process.argv[1])`. In the image `@getworkdone/db` is a symlink into `node_modules/.pnpm`, so the two never matched. `node node_modules/@getworkdone/db/dist/migrate-task.js` then exited 0 having run nothing, and `migrate.sh` would have reported the migrations applied. It was found by running the built image against a local Postgres. Fix: `isEntry` compares real paths.

Regression tests:

- `tests/scripts/rds-ca-bundle.test.ts` (unit), "holds exactly one certificate, the us-east-1 RSA2048 G1 root, as the bundle has it".
- `packages/db/src/database-url.test.ts` (unit), "gives the Prisma CLI DATABASE_PRISMA_SSL_CERT when set, and pg still DATABASE_SSL_ROOT_CERT".
- `deploy/sandbox/data/tests/rds.tftest.hcl` (the `tofu-test` gate), run "database_ca_is_pinned_to_the_committed_root".
- `packages/db/src/migrate-task.test.ts` (unit), "is true for the module itself and through a symlinked directory".

Not proven before the first live run: that RDS's real chain (the server's certificate, the regional intermediate it sends, then the pinned root) verifies in Prisma with the single root. The first dev migrate log ends with `app role getworkdone_app: created or updated` when it does.

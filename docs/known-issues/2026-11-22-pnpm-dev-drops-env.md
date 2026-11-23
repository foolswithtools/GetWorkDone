# pnpm dev ran the API without the variables it was started with

Found while checking that the public twin's README holds up from source, before the docker compose PR merged. `DATABASE_URL=... OIDC_ISSUER_URL=... OIDC_CLIENT_ID=... OIDC_CLIENT_SECRET=... OIDC_REDIRECT_URI=... pnpm dev` started an API that connected to the default `localhost:5432` database (`password authentication failed for user "getworkdone"` against another Postgres on that port) and answered `/auth/login` with 503, as if sign-in had never been configured.

`pnpm dev` is `turbo run dev`. Turbo 2 runs tasks in strict env mode: a task sees only the variables declared for it, plus a few of turbo's own. The `dev` task declared none, so the API saw none of `DATABASE_URL`, `OIDC_*`, `OTEL_SDK_DISABLED` or the rest. The README's Quick start has always told people to set them for `pnpm dev`. `pnpm build`, the tests and the image are not affected, because the API reads its environment only at run time and nothing else starts it through turbo.

Fix: the `dev` task in `turbo.json` lists every variable the API and the packages read in `passThroughEnv`. The variables are passed through, so they still play no part in any cache key.

Regression test: `tests/scripts/turbo-config.test.ts`, "passes every variable the API reads through to pnpm dev". It reads the names from the source (`tests/scripts/env-names.ts`), so a new variable fails the test until `turbo.json` passes it through.

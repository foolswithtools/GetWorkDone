# GetWorkDone

A generic internal business app where teams define their own work as capture
(forms), process (ordered human and automated steps) and distribute (email,
webhook, export), built observability-first. This repository is its public
copy: clone it and use it how you wish.

It is a pnpm monorepo: a NestJS API (`apps/api`) that serves a Vite and React
app (`apps/web`), with shared packages for telemetry, Zod contracts and the
Prisma schema for Postgres (`packages/`). The [user guide](docs/guide/first-team.md)
walks through a first team, and [docs/](docs) describes each part of the app.

## Try it with Docker

Needs only Docker with Compose.

```
git clone https://github.com/foolswithtools/GetWorkDone.git
cd GetWorkDone
docker compose up --build
```

Open http://localhost:8080 and sign in as `admin@example.com` with the password
`getworkdone`. Email outputs land in Mailpit at http://localhost:8025.
`docker compose down -v` stops everything and deletes the database.

[`compose.yaml`](compose.yaml) runs Postgres 16, the image's migrate command,
the API, [Dex](https://dexidp.io) as a local sign-in provider
([`deploy/local/dex.yaml`](deploy/local/dex.yaml)) and Mailpit. This is for
trying the app out, not for real use:

- every password in it is public;
- telemetry stays in the process.

Use Chrome or Firefox. The session cookies are `Secure` over plain http, which
both accept on `localhost` and Safari does not: in Safari, sign-in ends at
`/auth/callback` with "No sign-in in progress". If you recreate only the `api`
service, run `docker compose up -d` afterwards so Dex rejoins it.

To sign in with your own OIDC provider instead of Dex, register
`http://localhost:8080/auth/callback` with it, then:

```
export OIDC_ISSUER_URL=https://issuer.example.com OIDC_CLIENT_ID=... OIDC_CLIENT_SECRET=...
docker compose up --build api mailpit
```

## Run it from source

You need:

- **Node 24** (`.nvmrc`). `.npmrc` sets `engine-strict=true`, so `pnpm install`
  fails on any other Node line.
- **pnpm 10.32.1**: `bash scripts/install-pnpm.sh` installs it from its
  tarball, checked against a pinned sha512.
- **Postgres 16.**
- **An OIDC provider** for sign-in (Dex, Keycloak, Okta, Auth0, Cognito and so
  on). Without one the app still starts, but `/auth/login` answers 503 and no
  one can sign in.

```
pnpm install --frozen-lockfile

docker run -d --name getworkdone-pg -p 5432:5432 \
  -e POSTGRES_USER=getworkdone -e POSTGRES_PASSWORD=getworkdone -e POSTGRES_DB=getworkdone postgres:16-alpine
pnpm db:migrate          # the API never migrates by itself

export OTEL_SDK_DISABLED=true   # no OpenTelemetry collector on localhost:4318
export OIDC_ISSUER_URL=... OIDC_CLIENT_ID=... OIDC_CLIENT_SECRET=... \
  OIDC_REDIRECT_URI=http://localhost:5173/auth/callback
pnpm dev                 # API on :8080, the web app's dev server on :5173
```

Open http://localhost:5173. The dev server passes `/auth` and `/api` through
to the API, so register `http://localhost:5173/auth/callback` with your
provider. The issuer must use https, unless it is plain http on `localhost` or
`127.0.0.1`. For a local issuer, run Dex with the compose file's config. Its
client is `getworkdone-local`, the secret is the same, and the issuer is
`http://localhost:5556/dex`:

```
docker run -d -p 5556:5556 -v "$PWD/deploy/local/dex.yaml:/etc/dex/config.yaml:ro" \
  ghcr.io/dexidp/dex:v2.46.1 dex serve /etc/dex/config.yaml
```

`pnpm lint` and `pnpm test:unit` need nothing else. `pnpm test:integration`
needs the Postgres above. `pnpm e2e` needs it too, and runs against the built
app: `pnpm build` first, and `pnpm exec playwright install chromium` once.

## Configuration

The API reads its settings from the environment.

| Variable | Default | What |
|---|---|---|
| `DATABASE_URL` | `postgresql://getworkdone:getworkdone@localhost:5432/getworkdone` | Postgres. |
| `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` | unset | Sign-in. Set all four or none; the redirect URI is this app's `/auth/callback`. |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Where the API listens. |
| `TRUST_PROXY_HOPS` | `0` | Proxies in front of the API to trust for the client address; `1` behind one load balancer. |
| `EMAIL_TRANSPORT` | unset | `smtp` (with `SMTP_URL`) or `ses` (with `AWS_REGION`). Unset, email outputs fail with `email_not_configured`. |
| `EMAIL_FROM` | unset | The sender of email outputs. |
| `OTEL_SDK_DISABLED` | unset | `true` keeps telemetry in the process. Otherwise traces, metrics and logs go over OTLP to `OTEL_EXPORTER_OTLP_ENDPOINT` (`http://localhost:4318`). |
| `GETWORKDONE_ENVIRONMENT`, `GETWORKDONE_INSTANCE`, `GETWORKDONE_VERSION` | `local`, the host name, `dev` | Labels on every span, metric and log line. |
| `LOG_LEVEL` | `info` | |
| `LOGIN_RATE_LIMIT` | `20` | Sign-ins a minute per client address. |
| `R4C_SIGNING_KEY` | unset | The request-4-change feedback widget's key; unset, the widget is hidden ([docs/r4c.md](docs/r4c.md)). |

Quotas, sweeper intervals and the delivery worker have their own settings,
described in [docs/domain.md](docs/domain.md), [docs/process.md](docs/process.md)
and [docs/outputs.md](docs/outputs.md).

## Deploying it

The [`Dockerfile`](Dockerfile) builds one image. It serves the API and the web
app on port 8080 as a non-root user, and it also runs the migrations:

```
node node_modules/@getworkdone/db/dist/migrate-task.js
```

This runs `prisma migrate deploy`, then, when `DATABASE_APP_CREDENTIALS` is set
(`{"username":"getworkdone_app","password":"..."}`), creates the
least-privilege role the API should connect as. `compose.yaml` shows the order:
migrate as the database owner, then start the API as `getworkdone_app`.

This repository does not include infrastructure code. To deploy it, you
provide:

- somewhere to run the container, behind TLS;
- a managed Postgres;
- a one-off migrate run before each release;
- an OIDC provider;
- an email transport;
- a place to keep the secrets.

Nothing in the app is tied to a particular cloud.

## CI

One workflow, [`.github/workflows/ci.yml`](.github/workflows/ci.yml), runs on
every pull request and every push to `main`: the workflow guard, then
`pnpm lint` and `pnpm test:unit`. It has a read-only token and no credentials,
so there is nothing in it to steal. Integration, end-to-end and deploy gates
run in the private repository, never here.

`scripts/ci-guard.sh [dir]` (default `.github/workflows`) exits 1 and prints
`file:line` for any workflow that references the secrets context, requests an
OIDC token or uses the privileged pull-request trigger, and exits 0 otherwise.
CI runs it before anything else, so a change that adds any of them fails.

## How content arrives

Nothing is committed to this repository directly. Code arrives only as
snapshot pull requests from the private repository: a tagged, allowlisted,
scanned and squashed copy of the published paths, which a maintainer reviews
and merges. There is no live mirror.

Once protected, `main` takes changes only through a reviewed pull request with
a green `ci` check. The owner applies the protection with:

```
bash scripts/branch-protection.sh foolswithtools/GetWorkDone
gh api repos/foolswithtools/GetWorkDone/branches/main/protection \
  --jq '[.required_status_checks.contexts, .enforce_admins.enabled,
         .required_pull_request_reviews.dismiss_stale_reviews,
         .required_pull_request_reviews.require_last_push_approval]'
# expect [["ci"],true,true,true]
```

Examples use `example.com` and placeholder values for domains, account ids
and role names. Replace them with your own.

## Licence

MIT, see [`LICENSE`](LICENSE).

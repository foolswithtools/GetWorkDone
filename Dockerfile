# Image getworkdone-api: the NestJS API with the built SPA it serves (D-026). Build from the repo root:
#   docker build -t getworkdone-api .
# Both stages use the Node 24 base pinned by index digest (prebutton.md:344-355, pinned images), so
# amd64 and arm64 builds resolve the same image. The build stage installs, builds every workspace and
# deploys the API's production dependencies; @datadog/pprof (under @pyroscope/nodejs) is built for
# this platform there and checked to load in the runtime stage. Runs as the non-root node user and
# carries no credentials.
#
# The image also runs the database migrations, as the one-off migrate task (#8,
# deploy/sandbox/migrate.sh), with its documented migrate command:
#   node node_modules/@getworkdone/db/dist/migrate-task.js
# which runs `prisma migrate deploy`, then creates or updates the API's role getworkdone_app with
# `prisma db execute --stdin` (#57, packages/db/sql/app-role.sql). prisma is a production dependency of
# @getworkdone/db and of the API. ci runs that command, as migrate.sh does, against an empty database
# (scripts/image-migrate-check.sh, #100).
# Both stages install openssl: without it Prisma cannot detect libssl, picks the openssl-1.1.x schema
# engine, which bookworm cannot run, and tries to download it at run time; the build installs the
# openssl-3.0.x engine, and `prisma --version` below fails the build if the runtime cannot use it.

FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
WORKDIR /repo
# pnpm from its registry tarball, checked against the sha512 committed in the script (#51); curl only here.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl openssl && rm -rf /var/lib/apt/lists/*
COPY scripts/install-pnpm.sh scripts/
RUN bash scripts/install-pnpm.sh
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm build \
    && pnpm --filter @getworkdone/api deploy --prod --legacy /out

FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
ARG GETWORKDONE_VERSION=dev
ENV NODE_ENV=production \
    GETWORKDONE_VERSION=${GETWORKDONE_VERSION} \
    PORT=8080 \
    WEB_DIST_DIR=/app/public
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY --from=build /out ./
COPY --from=build /repo/apps/web/dist ./public
# #57: the RDS CA bundle for the API's pg adapter (DATABASE_SSL_ROOT_CERT), and the one root the instance
# chains to for the Prisma CLI, which trusts only a file's first certificate (DATABASE_PRISMA_SSL_CERT).
COPY deploy/rds/global-bundle.pem /app/rds-ca.pem
COPY deploy/rds/rds-ca-rsa2048-g1-us-east-1.pem /app/rds-ca-prisma.pem
# Fails the build if the native profiler addon was not built for this platform: loads
# @pyroscope/nodejs from where @getworkdone/telemetry's profiling.ts imports it.
RUN node --input-type=module -e "import { createRequire } from 'node:module'; \
    const telemetry = createRequire(import.meta.resolve('@getworkdone/telemetry')); \
    await import(telemetry.resolve('@pyroscope/nodejs')); console.log('pprof addon loads');"
USER node
# As the node user, as the migrate task runs it: exits 1 when the schema engine cannot run here.
RUN node_modules/.bin/prisma --version
EXPOSE 8080
CMD ["node", "dist/main.js"]

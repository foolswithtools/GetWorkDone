# Domain model

GetWorkDone models work as capture, processing and distribution of data (spec §4.3; G2 to G4). A team owns work types; a work type's definition says what to capture, which steps to run in order and where the result goes; an item is one piece of work moving through those steps with an audit trail. Work types are defined structurally, with no LLM (D-028). This page fixes the entities and their rules (GWP#2); the slices after it build on them and never redefine them.

## The contract

`packages/contracts/src/domain.ts` is the one definition of the shapes, in Zod: `FieldType`, `CaptureField`, `ProcessStep`, `OutputKind`, `DistributionOutput`, `WorkTypeDefinition` and `ItemStatus`. Import them from `@getworkdone/contracts`.

A `WorkTypeDefinition` has:

- `fields`: at least one capture field. Keys are lower snake case (`^[a-z][a-z0-9_]{0,62}$`) and unique within the definition. `required` defaults to false; `options` applies to `select` only. Each field's settings are checked at definition time, unsafe patterns included ([capture.md](capture.md)).
- `steps`: process steps, human (`assigneeRole` `member` or `admin`, and optionally `decisions`: 1 to 10 texts of 1 to 40 characters, recorded on the step's `step_completed` event and never branched on; GWP#54, [process.md](process.md) "Decisions") or automated (`transform` and `params`). Array order is execution order; zero steps is allowed. Step ids are unique.
- `outputs`: one to `MAX_OUTPUTS` (5) distribution outputs: `none`, `persist`, `email`, `webhook` or `export`. `none` cannot be combined with any other output. Output ids and each kind's config are checked at save ([outputs.md](outputs.md)); an email output names at most `MAX_RECIPIENTS` (20) recipients, and all of a definition's email outputs together at most `MAX_RECIPIENTS_PER_ITEM` (20), so one item is emailed to 20 addresses at most (`packages/contracts/src/distribute.ts`).

### Limits and quotas (GWP#50)

Any signed-in subject can create a team and configure its outputs, so what one subject or one team can ask for is bounded. The two definition limits above are contract constants: a definition past either is 422 `{ errors }` keyed `definition.outputs` on both definition routes ([capture.md](capture.md)), and the builder shows the message beside the outputs. The rest are quotas, read at startup:

| Variable | Default | What it bounds | Past it |
|---|---|---|---|
| `QUOTA_TEAMS_PER_SUBJECT_PER_DAY` | 5 | `POST /api/v1/teams` by one subject in 24 hours (key `teams:<subject>`) | 429 with `Retry-After` |
| `QUOTA_WORK_TYPES_PER_TEAM` | 50 | Active (unarchived) work types one team has: a cap, not a window, counted under the team's row lock on create and on unarchive; archived work types do not count, so archiving one frees its place (GWP#103) | 409 `This team has reached its limit of 50 work types`, on create or on unarchiving an archived one |
| `QUOTA_ITEMS_PER_SUBJECT_PER_MINUTE` | 60 | `POST .../work-types/:id/items` by one subject in a minute, on any team (key `items:<subject>`) | 429 with `Retry-After` |
| `QUOTA_DELIVERIES_PER_TEAM_PER_HOUR` | 500 | Webhook and email attempts for one team in an hour (key `deliveries:<teamId>`) | deferred to the window's end, not an attempt ([outputs.md](outputs.md) "Retry policy") |
| `QUOTA_EXPORTS_PER_TEAM_PER_HOUR` | 20 | `POST .../exports` for one team in an hour, beside the 30 s per work type (key `exports:<teamId>`) | 429 with `Retry-After` |

- A value that is not a positive whole number leaves the default; there is no "unlimited". A changed value applies at the next start. At startup the API logs one line, `quotas`, with the five effective values (and `enforced`), so a misread variable shows in Loki.
- The windows are fixed: a key's window starts at its first take and lasts a day, a minute or an hour. The counts live in Postgres (`QuotaWindow`, one row per key), so every API task shares them and a restart keeps them; one `INSERT ... ON CONFLICT DO UPDATE` counts each take under the key's row lock (`apps/api/src/common/quota.ts`). The session purge deletes a row once `windowStart + windowMs` has passed. The sign-in limit keeps its own table ([auth.md](auth.md)).
- A route takes its quota after authentication, CSRF and membership and before it reads the body, so a refused request writes nothing, and a request that then fails validation has still counted: a quota bounds work, not successes. A 429 carries `Retry-After`, the whole seconds to the window's end, and a one-line message; the RED metrics record it as `status_class="4xx"`. If Postgres cannot be reached the route answers 503 rather than skip the quota.
- Admins are not exempt, and there are no per-team overrides.
- Under `NODE_ENV=test` no quota is enforced unless a test passes limits through `createApp({ quotas })` (`apps/api/test/quotas.integration.test.ts`), as the worker's `autoRun` is off there: the integration files share one Postgres and reuse subjects. The e2e API runs in production mode with `QUOTA_ITEMS_PER_SUBJECT_PER_MINUTE` raised for its paging journey, and `LOGIN_RATE_LIMIT` raised because every spec signs in from one address (`tests/e2e/support/api-server.ts`, #133).
- In the SPA, the capture form and the create-team form keep their button disabled for the `Retry-After` seconds after a 429 and count them down ("You can submit again in N seconds.", "You can create a team again in N seconds."), as the exports panel does.

The `/api/v1` request and response bodies are in `packages/contracts/src/api-v1.ts`.

## Entities

Prisma models in `packages/db/prisma/schema.prisma`; the migration is `packages/db/prisma/migrations/20261021120000_domain`, and later slices add their own (`Identity`: `20261102120000_identity_profile`, GWP#99).

| Entity | What it holds |
|---|---|
| `Team` | A tenant: `name`. |
| `TeamMember` | `teamId`, `subject` (the identity provider's `sub`), `role` `member` or `admin`; one row per subject per team. The creator of a team is its first admin; admins add and remove members, and a team always keeps an admin (GWP#20, [auth.md](auth.md) "Team membership"). |
| `Identity` | `subject` (the key), `email`, `displayName` (null when the provider asserted no name), `updatedAt`: a person's profile as their identity provider last asserted it, upserted on every sign-in. Not keyed by team and with no foreign key to `TeamMember`; the members list joins it by subject, for admins only (GWP#99, [auth.md](auth.md) "Team membership"). The session purge deletes it once its last sign-in (`updatedAt`) is 90 days old and its subject is in no team and has no unexpired session (GWP#143). |
| `WorkType` | `teamId`, `slug` (lower kebab case, unique within the team), `archivedAt` (null, or when an admin archived it: it then takes no new items or versions and its items stay readable; GWP#55, [process.md](process.md) "The API"). |
| `WorkTypeVersion` | `teamId`, `workTypeId`, `version` (1, 2, 3, ...), `definition`: a `WorkTypeDefinition`, validated before every write and stored as parsed, with defaults filled in. Immutable. |
| `Item` | `teamId`, `workTypeVersionId` (the version it was captured under), `data` (the captured values), `status` (`ItemStatus`, starts `open`), `currentStepIndex` (starts 0), `rowVersion` (optimistic locking, starts 0), `waitingRole` (the `assigneeRole` of the human step it is waiting at, else null; kept by every transition, GWP#55, [process.md](process.md) "How an item moves"), `sweepRetryAt` (when the stuck-item sweeper may next try an item whose advance it could not make, else null) and `sweepFailures` (how many of its advances in a row failed, starts 0; both cleared by every transition, GWP#102, [process.md](process.md) "Resume"). |
| `Delivery`, `OutputSecret`, `Export` | Distribution (GWP#6): one row per completed item and email or webhook output, each webhook output's signing secret, and on-request exports ([outputs.md](outputs.md)). Each carries `teamId`, matched to its parent's like the rows above. |
| `ItemEvent` | The append-only audit trail: `itemId`, `seq` (1, 2, 3, ... within the item), `type`, `actorSubject` (null when no person caused the event), `at`, `payload`. An item's first event is `item.created`, or `captured` when it comes from the capture form (GWP#4). |

### Rules the database enforces

- **ItemEvent is append-only.** A trigger rejects every `UPDATE` and `DELETE` on a row, and `TRUNCATE` of the table, with `ItemEvent is append-only`.
- **WorkTypeVersion is immutable.** A trigger rejects every `UPDATE` and `DELETE` with `WorkTypeVersion is immutable`. Changing a work type writes the next version row (`WorkTypesService.reviseDefinition`), so an item always keeps the definition it was captured under.
- **The API's role has table DML only (#57).** In the sandbox the API connects as `getworkdone_app` (`packages/db/sql/app-role.sql`, created by the migrate task): `SELECT`, `INSERT`, `UPDATE` and `DELETE` on the tables of schema `public` and use of its sequences, and nothing else. It cannot create, drop, alter or truncate a table, so it cannot disable the triggers above, and it cannot read `pg_authid` or `_prisma_migrations`. It inherits neither `TEMPORARY` on the database nor `EXECUTE` on the functions of schema `public` from `PUBLIC` (#121); the triggers still fire for it, since Postgres does not check `EXECUTE` on a trigger function when it fires. The migrations run as RDS's master user. Locally and in CI the API keeps the superuser `getworkdone`; `packages/db/test/app-role.integration.test.ts` checks the role on CI's Postgres.
- **A row's team matches its parent's.** `WorkTypeVersion` references `WorkType` by `(workTypeId, teamId)` and `Item` references `WorkTypeVersion` by `(workTypeVersionId, teamId)`, so an item can never point at another team's work type.

## Tenancy

Tenancy is team-scoped rows in one database. Every table except `ItemEvent` and `Identity` carries `teamId`; `ItemEvent` is only read through its item, and `Identity` (one per person, not per team) only through a team's members list, matched to that team's members by subject (GWP#99). Every query in the domain services (`apps/api/src/modules/teams`, `work-types`, `items`) takes `teamId` and matches on it, so a read of another team's row is a 404, exactly as if the row did not exist. In front of that, the team guard (GWP#3) answers 403 on any `/api/v1/teams/:teamId/*` route when the caller has no `TeamMember` row in `:teamId`, so a team that does not exist, or one the caller is not in, is a 403 before any service runs.

## The API and identity

| Route | What |
|---|---|
| `GET /api/v1/teams` | The teams the caller is a member of. |
| `POST /api/v1/teams` | Create a team (`{ name }`, 1 to 120 characters; a malformed body is 400 `{ message, issues }`); the caller becomes its admin. The SPA's **Create a team** form under the team list posts it (GWP#49, [auth.md](auth.md) "Team membership"). |
| `GET`, `POST /api/v1/teams/:teamId/members`, `DELETE .../members/:subject` | (Admins) list, add and remove the team's members (GWP#20, [auth.md](auth.md) "Team membership"). |
| `GET /api/v1/teams/:teamId/work-types` | The team's work types, each with its latest version and `archivedAt`; archived ones only with `?includeArchived=true` (GWP#55). |
| `POST /api/v1/teams/:teamId/work-types/:id/archive`, `.../unarchive` | (Admins) archive or unarchive a work type, body `{}` (GWP#55, [process.md](process.md) "The API"). |
| `POST /api/v1/teams/:teamId/work-types` | Create a work type (`{ slug, definition }`) and its version 1. An invalid body or definition is 422 `{ errors }` keyed by path, as on a new version ([capture.md](capture.md)), and so are steps that fail the save-time step checks ([process.md](process.md)); a slug the team already uses is 409. |
| `GET /api/v1/teams/:teamId/items?waiting=me` | The waiting-for-me queue: the team's items waiting at a human step whose role the caller holds, across its work types, newest first, paged by `?cursor=`, with `?status=` (GWP#55, [process.md](process.md) "The API"). |
| `GET /api/v1/teams/:teamId/items/:itemId` | One item with its audit trail and the steps and fields of the version it was captured under (GWP#5, GWP#23). |
| `POST /api/v1/teams/:teamId/items/:itemId/steps/:stepId/complete`, `.../retry` | Complete a human step, or (admins) retry a failed automated step, with the item's `rowVersion` (GWP#5, [process.md](process.md)). |
| `POST /api/v1/teams/:teamId/items/:itemId/data` | (Admins) replace the data of a failed item, or of one waiting at a human step, with its `rowVersion` (GWP#23, [process.md](process.md) "Editing data"). |
| `POST /api/v1/teams/:teamId/items/:itemId/cancel` | (Admins) cancel an `open`, `in_progress` or `failed` item with its `rowVersion` and an optional reason (GWP#54, [process.md](process.md) "Cancel"). |
| `POST /api/v1/teams/:teamId/items/:itemId/advance` | (Admins) resume an item whose processing stopped between transitions, with its `rowVersion` (GWP#22, [process.md](process.md) "Resume"). |
| `POST /api/v1/teams/:teamId/work-types/:id/versions`, `POST` and `GET .../items` | The next version, and capture (GWP#4, [capture.md](capture.md)). |
| `GET .../items/:itemId/deliveries`, `POST` and `GET .../work-types/:id/exports`, `GET .../exports/:exportId/download` | An item's deliveries, and exports (GWP#6, [outputs.md](outputs.md)). |
| `GET /api/v1/me` | The signed-in identity, its CSRF token and its team memberships (GWP#3, [auth.md](auth.md)). |

Every `/api/v1` path is deny-by-default: a global guard (`apps/api/src/common/deny-by-default.guard.ts`) answers 401 when the request carries no signed-in session, on every registered route and for a GET of an unknown path under `/api/v1` (other methods on unknown paths are Nest's 404, decided before any guard). The guard and the SPA fallback match a path as sent and in its decoded, dot-resolved form, so `//api/v1/me`, `/%2Fapi/v1/me`, `/x/../api/v1/me` and `/\api/v1/me` are all `/api/v1` and never `index.html` (GWP#15, GWP#30). `/healthz`, `/auth` and the SPA stay open. Every `/api/v1/teams/:teamId/*` route needs a `TeamMember` row for the caller (403 otherwise), work-type writes, the members routes and an item's retry, resume, data edit and cancel need the `admin` role, and state-changing requests need the `X-GWD-CSRF` header. Sign-in, sessions and these checks are described in [auth.md](auth.md).

Items are created through `ItemsService.create`, which the capture route calls after validating the data against the latest version's fields ([capture.md](capture.md)); the process engine then moves them through their steps ([process.md](process.md)).

## Output semantics (D-048)

- `persist`: the captured `Item.data` is kept after the item completes.
- `none`: `Item.data` is cleared when the item completes; every `ItemEvent` row is kept.
- `email`, `webhook`, `export`: delivered as described in [outputs.md](outputs.md) (GWP#6). The `completed` transition writes the deliveries and, for `none`, clears the data, in one transaction.

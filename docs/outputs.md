# Outputs: distributing completed items

Distribution is GetWorkDone's third verb (GWP#6, spec §4.3). When an item completes, its work type's outputs decide what happens to it: nothing more (`persist`), its captured data cleared (`none`, D-048), a signed POST to a URL (`webhook`), an email (`email`), or a place in the next file export (`export`). Decisions are cited by number from the program register (spec §9.4) and never copied here. The entities are in [domain.md](domain.md) and the process that completes items in [process.md](process.md).

## Kinds and their config

A definition's `outputs` (`DistributionOutput` in `packages/contracts/src/domain.ts`) is at least one `{ id, kind, config }`. Each kind's `config` schema is in `packages/contracts/src/distribute.ts` (`OUTPUT_CONFIGS`), shared by the API and the builder's output editor.

| Kind | Config | When the item completes |
|---|---|---|
| `persist` | `{}` | Nothing more: the captured data is kept. |
| `none` | `{}` | `Item.data` is cleared to `{}` in the `completed` transition itself; every `ItemEvent` is kept, and the `completed` event's payload is `{ "dataCleared": true }` (D-048). `none` cannot sit beside another output. |
| `webhook` | `url` (https, no user name or password, at most 2048 characters), `deadlineMs` (optional, 1000 to 30000, default 10000) | One `POST`, retried as below. |
| `email` | `recipients` (1 to 20 addresses), `subject` (optional, at most 200 characters), `deadlineMs` (as for webhooks) | One plain-text message to exactly those recipients, retried as below. |
| `export` | `format`: `csv` (default) or `json` | Nothing is sent; the item is in the next export a member asks for. |

Output ids are 1 to 64 letters, digits, dashes and underscores, unique in the definition: an id is half of each delivery's idempotency key. The editor generates `output_N`.

### Checks at save

Every write of a definition (`POST .../work-types` and `POST .../work-types/:id/versions`) runs the contract's `outputProblems` beside the step checks ([process.md](process.md)): each id, each config against its kind's schema, and the recipients of all the email outputs together, at most `MAX_RECIPIENTS_PER_ITEM` (20, message `At most 20 recipients across all email outputs`, keyed `definition.outputs`; each email output also stays at most `MAX_RECIPIENTS`, 20). A definition has at most `MAX_OUTPUTS` (5) outputs, refused by the contract at `definition.outputs` (GWP#50, [domain.md](domain.md) "Limits and quotas"). A failure is 422 `{ "errors": { "definition.outputs.0.config.url": [...] } }` and writes nothing. These checks look at shape only: a webhook aimed at a blocked address is saved, and refused each time it is sent to (below). The builder runs the same function as you type.

## Deliveries

The `completed` transition (`ProcessService.advance`) writes, in its own transaction, one `Delivery` row per `email` and `webhook` output:

| Column | What |
|---|---|
| `itemId`, `outputId`, `kind`, `teamId` | Which item, which output. |
| `idempotencyKey` | `<itemId>:<outputId>`, unique. Sent as the webhook's `Idempotency-Key` on every attempt. |
| `status` | `pending`, `delivered` or `failed`. |
| `attempts` | Attempts started. |
| `lastError` | The last attempt's reason (below), cleared on delivery. |
| `nextAttemptAt` | When a pending row is next due. |
| `deliveredAt` | When it was delivered. |

Because the rows are written with the `completed` event, a completed item always has them; nothing is lost if the process stops right after the commit. `ProcessService.onItemCompleted` then wakes the worker so delivery starts at once; the worker also polls every `DELIVERY_POLL_MS` (default 5000). On an instance's first deploy the API starts before its migration, so the worker first waits for the `Delivery` table (GWP#101): it checks with `to_regclass` at once and then from `DELIVERY_POLL_MS` doubling up to 60 s, logs `delivery worker waiting for the database schema` once at `warn`, claims nothing (a wake is ignored), and when the table exists logs `delivery worker started` at `info` and polls as above. It never checks again, so a run that fails later still logs `delivery run failed` at `error`. Since it waits for `Delivery` alone, it reads an item with only the columns it sends, never every column: a column a later migration adds to `Item` (such as `sweepRetryAt`) is then not needed before that migration lands, and a due delivery is not used up on an API started before it (GWP#127). The backlog gauge waits the same way and skips its exports until then.

### The worker and idempotency

The delivery worker (`apps/api/src/modules/distribute/delivery.worker.ts`) claims one due row at a time:

1. **Claim**, in a short transaction: `SELECT id FROM "Delivery" WHERE status = 'pending' AND "nextAttemptAt" <= now ORDER BY "nextAttemptAt" LIMIT 1 FOR UPDATE SKIP LOCKED`, then `attempts + 1` and `nextAttemptAt = now + 60 s` (the lease, longer than the longest deadline). Commit.
2. **Send**, outside any transaction, through the kind's adapter, inside the `distribute.deliver` span.
3. **Record** the outcome with an `UPDATE ... WHERE id = $id AND status = 'pending' AND attempts = $claimed`, so only the worker that holds the claim writes it.

So two workers racing one row send it once (`SKIP LOCKED`, then the lease), and a delivered row is never sent again. A worker that dies between a send and its record leaves the row pending; when the lease lapses the row is sent again with the same `Idempotency-Key` and the same body, so a receiver that keeps the keys it has seen can drop the duplicate. Email has no such header: a crash at that moment can send a message twice.

### Stopping a task (#8)

On SIGTERM (a deploy replacing the task, or a scale-in) the worker claims no new row and finishes the attempts it already holds (`delivery.worker.ts`), then the API flushes its telemetry (`apps/api/src/main.ts`). One attempt is capped at `MAX_DEADLINE_MS`, 30 s (`packages/contracts/src/distribute.ts`), so the sandbox's app stage sets the ECS `stop_timeout` to **60 s** (`deploy/sandbox/app/main.tf`): time for an attempt at its deadline, its record and the flush, before ECS kills the container. If a task is killed anyway, the rows it held stay `pending` and their 60 s lease lapses; the next task claims them and sends again with the same `Idempotency-Key`, as for a worker that dies (above).

### Retry policy

An adapter answers `delivered`, `retryable` (it may pass) or `failed` (it will not).

- At most **3 attempts**. After the first retryable failure the row waits **30 s**, after the second **2 min**; the third failure is final. (`BACKOFF_MS` holds a third step, 10 min, which only a larger `MAX_ATTEMPTS` would reach.)
- A `failed` answer, or a third retryable one, ends the row `failed` and writes an `ItemEvent` `delivery_failed` with `{ outputId, kind, attempts, reason }` and no actor. The item stays `completed`.
- A row whose third attempt's claim lapsed (the worker died before recording it) is never sent a fourth time: the next claim ends it `failed` with reason `interrupted`.
- Each attempt has a deadline: the output's `deadlineMs`, 10 s by default and at most 30 s. An attempt past it is aborted and is `retryable` with reason `timeout`.
- **Deliveries quota** (GWP#50): a team sends at most `QUOTA_DELIVERIES_PER_TEAM_PER_HOUR` (500) webhook and email attempts an hour, counted across every API task ([domain.md](domain.md) "Limits and quotas"). The worker takes it after the claim and before the send; past it the row is **deferred, not failed**: the same guarded write as an outcome, `UPDATE "Delivery" SET attempts = attempts - 1, "nextAttemptAt" = <window end>, "lastError" = 'quota_deferred' WHERE id = $id AND status = 'pending' AND attempts = $claimed`, reverts the claim. A deferral never counts toward the 3 attempts (so `interrupted` cannot fire because of it), the row stays `pending`, no `ItemEvent` is written, and the first claim after the window sends it. One quota covers both kinds because both spend the task role's reach; the recipient caps bound each email attempt's fan-out.

| Reason | Kind | Outcome |
|---|---|---|
| `timeout` | webhook, email | retryable |
| `network_error`, `dns_error` | webhook, email | retryable |
| `http_5xx`, `http_408`, `http_425`, `http_429` | webhook | retryable |
| `http_4xx` (others) | webhook | failed |
| `redirect_not_followed` | webhook | failed |
| `blocked_address` | webhook | failed |
| `https_required`, `invalid_config` | webhook, email | failed |
| `throttled`, `ses_<5xx error>` | email (SES) | retryable |
| `recipient_not_verified` | email (SES sandbox) | failed, never retried |
| `message_rejected`, `ses_<other error>` | email (SES) | failed |
| `smtp_4xx` / `smtp_5xx` | email (SMTP) | retryable / failed |
| `email_not_configured` | email | failed |
| `output_not_found`, `adapter_error` | any | failed / retryable |
| `interrupted` | any | failed: the last attempt's claim lapsed |
| `quota_deferred` | webhook, email | deferred, not an attempt: the team's deliveries quota was spent; due again at the window's end |

### Watching deliveries (GWP#53)

- **Failed-delivery alert.** `<env> delivery failed` (warning) opens an OnCall alert group, and pages nobody, when any delivery ended `failed` in the last hour (`distribution_deliveries_total{status="failed"}`). A failed delivery is final, so a person looks at the reason and tells the team; [runbooks/delivery-failed.md](runbooks/delivery-failed.md).
- **Backlog gauge.** `distribution_deliveries_pending` is the number of `pending` rows, counted through the `[status, nextAttemptAt]` index on each metrics export (every 15 s, 5 s timeout; `apps/api/src/modules/distribute/delivery.backlog.ts`). Every task counts the same table, so the dashboard and the rule take the max. `<env> delivery backlog` (warning) fires when it stays above 50 for 30 minutes: the worker is not draining.

Both are in [observability.md](observability.md) "Signals", with the dashboard's two delivery panels.

## Webhooks

`apps/api/src/modules/distribute/webhook.adapter.ts`. Each attempt is one `POST` to the output's URL with:

- body: JSON `{ "item": { id, teamId, workTypeVersionId, data, createdAt }, "workType": { id, slug, version }, "completedAt" }`;
- `Content-Type: application/json`, `User-Agent: GetWorkDone-Webhook/1`;
- `Idempotency-Key: <itemId>:<outputId>`;
- `X-GetWorkDone-Signature: sha256=<hex HMAC-SHA256 of the exact body bytes, keyed with the output's secret>`.

Any `2xx` is delivered. Redirects are never followed (`redirect: 'manual'`): a `3xx` is `failed` with `redirect_not_followed`. The receiver's response body is never read.

### The signing secret

Each webhook output has its own secret: 32 random bytes as hex, generated when a save adds the webhook (its id was not a webhook output in the version before), and stored in `OutputSecret` keyed by work type and output id. A webhook carried over unchanged into the next version keeps its secret. One that is removed and later added again, even under the same id, gets a new secret, replacing the old one: it is a new receiver, which never saw the old secret. The secret is answered once, as `webhookSecrets: { <outputId>: <secret> }` in the response to that save, and the builder shows it then; no read returns it, and it is never part of a definition. To rotate a secret, remove the webhook, save, and add it again. Deliveries still pending from before a rotation are signed with the new secret. The secret is stored in the database as is, because signing needs it.

### Verifying a webhook (for receivers)

Compute the HMAC-SHA256 of the raw request body (before any JSON parsing) with the secret, hex-encode it, prefix `sha256=`, and compare it with `X-GetWorkDone-Signature` in constant time. Then use `Idempotency-Key` to drop a delivery you have already processed: the same item and output always carry the same key. In Node:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, rawBody, header) {
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const given = Buffer.from(header ?? '');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
```

`verifySignature` in the adapter is the same function.

### Blocked addresses

A webhook URL is user-configured, so the API checks where it would connect on every send: the URL's host, or every address its name resolves to, must be outside these ranges (`blocked-address.ts`); one blocked address refuses the send with `blocked_address`, and nothing is sent. The check runs twice: before the POST, and again inside the HTTP client's connect (undici's `fetch` through an `Agent` whose `lookup` resolves and checks the name), so the address dialled is always one that was checked. A name whose answer changes between the two (DNS rebinding) is refused at the second check.

| IPv4 | | IPv6 | |
|---|---|---|---|
| `0.0.0.0/8` | this network | `::/96` | unspecified, loopback `::1`, IPv4-compatible |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | private | `::ffff:0:0/96` | IPv4-mapped (any) |
| `100.64.0.0/10` | carrier-grade NAT | `64:ff9b::/96`, `2002::/16` | NAT64, 6to4 |
| `127.0.0.0/8` | loopback | `fc00::/7` | unique local, including `fd00:ec2::254` |
| `169.254.0.0/16` | link-local, including the metadata endpoints `169.254.169.254` and `169.254.170.2` | `fe80::/10` | link-local |
| `192.0.0.0/24`, `198.18.0.0/15` | protocol assignments, benchmarking | `ff00::/8` | multicast |
| `224.0.0.0/4`, `240.0.0.0/4` | multicast, reserved and broadcast | | |

Only `https://` URLs are accepted, at save and again at send (`https_required`). IPv4 written in other forms (`https://2130706433/`) is normalised by the URL parser before the check.


## Email

`apps/api/src/modules/distribute/email.adapter.ts`. One plain-text message per completed item, from `EMAIL_FROM` to the output's recipients only, with the output's subject (line breaks removed) or `<slug>: item completed`. The body lists each field's label and value in field order and the item id.

`EMAIL_TRANSPORT` chooses the transport:

| Value | Transport |
|---|---|
| `ses` | Amazon SES `SendEmail` (`@aws-sdk/client-sesv2`), region from `AWS_REGION`, credentials from the task role. The client makes one attempt; the worker retries. In the sandbox SES is in sandbox mode (D-041): an unverified recipient is rejected (`MessageRejected`, "not verified"), which ends the delivery `failed` with `recipient_not_verified` after one attempt. The sender identity, its DNS records and the send permission are GWP#8's. |
| `smtp` | SMTP through nodemailer at `SMTP_URL` (`smtp://user:password@host:587`, or `smtps://`), for installers without SES. |
| `memory` | Keeps messages in memory; tests only (the API refuses it unless `NODE_ENV=test`). |
| unset | No email: email outputs end `failed` with `email_not_configured`. |

## Exports

`apps/api/src/modules/distribute/exports.service.ts` and `export.adapter.ts`. A team member asks for an export of a work type whose latest version has an `export` output; the file holds the team's completed items of that work type, across all its versions, oldest first:

- **CSV**: header `item_id,completed_at,` then the field keys in the latest version's field order; CRLF line ends; cells with a comma, quote or line break are quoted; a text value starting with `=`, `+`, `-`, `@`, tab or carriage return is written with a leading `'`, so a spreadsheet shows it rather than running it.
- **JSON**: an array of `{ id, completedAt, data }`.

The file is generated on request, refused past 10 MB (422, nothing stored), and stored in an `Export` row with its format, size, item count and who asked. Generation runs in a `distribute.export` span.

Stored exports are bounded (GWP#25), so one member cannot fill the database by asking again and again:

- **One every 30 seconds per work type.** Within 30 seconds of a work type's last export, a new one is refused with 429 and `Retry-After` (the seconds left, rounded up) and nothing is stored. The check runs before the file is built and again when it is stored, under a lock on the team's row that orders the team's exports, so of two requests at once one is stored and the other is 429. Other work types of the team are not refused; their exports only wait for each other while being stored.
- **At most 10 per work type.** Storing an eleventh deletes the oldest in the same transaction; its download is then 404.
- **At most 7 days.** When a team generates an export, its exports of any work type older than 7 days are deleted in the same transaction. A team that stops exporting keeps its last ones until it exports again.

All three use the distribute clock (`now` in `DistributeOptions`), which also stamps the export's `createdAt`.

- **At most `QUOTA_EXPORTS_PER_TEAM_PER_HOUR` (20) an hour per team** (GWP#50), whichever work types they are of, in addition to the 30 seconds per work type: past it, 429 with `Retry-After` (the seconds until the team's window, an hour from its first export, ends) and nothing is built or stored. The quota is taken before the body is read and before the 30 s check, so a request refused as too soon still counts ([domain.md](domain.md) "Limits and quotas").

## The API

Every route is under the team checks in [auth.md](auth.md): 401 without a session, 403 for a non-member, and the `X-GWD-CSRF` header on writes.

| Route | Who | What |
|---|---|---|
| `GET /api/v1/teams/:teamId/items/:itemId/deliveries` | member | The item's deliveries (`DeliveryResponse`): output, kind, status, attempts, last error, next attempt, delivered at. |
| `POST /api/v1/teams/:teamId/work-types/:workTypeId/exports` | member | `{ format? }` (the export output's format when absent): generates an export; 201 with its metadata (`ExportResponse`). 422 when the work type has no export output or the file would pass 10 MB; 400 for an unknown format; 429 with `Retry-After` within 30 seconds of the work type's last export, or past the team's `QUOTA_EXPORTS_PER_TEAM_PER_HOUR` (20). |
| `GET /api/v1/teams/:teamId/work-types/:workTypeId/exports` | member | The work type's exports (at most 10 are kept), newest first, without their content. |
| `GET /api/v1/teams/:teamId/exports/:exportId/download` | member | The file, as an attachment (`text/csv` or `application/json`). `nosniff` is on every response now ([security.md](security.md)); the route still sets it and it is sent once. Another team's export is 404. |

The create and new-version routes of work types answer `webhookSecrets` once, as above.

## Telemetry

- Each attempt runs in a `distribute.deliver` span with `output.kind`, `output.id`, `delivery.attempt`, `item.id`, and after it `delivery.status` (and `delivery.reason` with an error status when not delivered). The webhook POST is a child span `distribute.webhook.request` (`http.request.method`, `server.address`, `http.response.status_code`); an email send is `distribute.email.send`. `scripts/instrument-lint.ts` checks that every `fetch` in `apps/api/src/modules` sits inside a `withSpan` callback.
- `distribution_deliveries_total{kind,status}` counts attempts by output kind and outcome (`delivered`, `retryable`, `failed`), through `recordDistributionDelivery` in `@getworkdone/telemetry`.
- `distribution_deliveries_pending` reports the pending rows (above, "Watching deliveries").
- Unit tests assert both (the coverage manifest's `distribution-metrics` and `delivery-backlog-gauge`, `kind: test`); no live check reads them.

## In the SPA

- **Output editor** (`apps/web/src/work-types/builder/outputs/`, in the builder, admins): add and remove outputs, choose each one's kind and its settings, with `outputProblems`' messages beside each input. A new work type starts with one `persist` output.
- **Webhook secrets**: after a save that generated any, the work type list shows them once, with a button to dismiss.
- **Deliveries panel** (`apps/web/src/items/deliveries.tsx`, in the item view): each delivery's status, attempts, last error and next try. The history names `delivery_failed` events and a completion that cleared the data.
- **Exports** (`apps/web/src/work-types/capture/ExportsPanel.tsx`, on the capture page of a work type with an export output): choose CSV or JSON, export the completed items, and download any earlier export. When an export is refused with 429, the button stays disabled for the `Retry-After` seconds and the panel counts them down ("You can export again in N seconds."); at 0 the button and the panel's message clear (`export-wait.ts`, GWP#35).

## Test isolation

The worker's claim takes every due `pending` row in its database, whoever wrote it (GWP#26).

- **Integration** (`apps/api/test/delivery.integration.test.ts`): the worker does not run on its own under `NODE_ENV=test`; each test calls `runOnce({ itemIds })` for its own items and drives every row it writes to `delivered` or `failed`. The file's last test, "leaves no Delivery row of this run pending", checks it for the file's team.
- **E2E**: every API a spec starts runs in production mode, so its worker runs at boot, on each completion and every `DELIVERY_POLL_MS`. A poll period cannot keep it off rows another suite left, so the run gets its own database. `tests/e2e/support/global-setup.ts` migrates the database at `DATABASE_URL` (as the integration partition does), creates `<name>_e2e_<random>` beside it, applies the migrations there, points every spec at it through `DATABASE_URL` and drops it after the run (`apps/api/test/support/scratch-database.ts`). A run killed before its teardown leaves its scratch database behind; drop it by hand. The role in `DATABASE_URL` needs `CREATEDB`; the README's and CI's `getworkdone` role is the container's superuser. `tests/e2e/isolation.spec.ts` seeds a due row in each database and checks the worker ends its own and leaves the other at `pending` with no attempt, then ends the shared seed `failed` (`test_ended`); versions cannot be deleted, so its team, work type and item stay. `EMAIL_TRANSPORT=memory` needs `NODE_ENV=test`, which also stops the worker, so `tests/e2e/outputs.spec.ts` sends its email output with `EMAIL_TRANSPORT=smtp` to a local sink, `tests/e2e/support/smtp-sink.ts`, and sees the delivery `delivered` (GWP#70).

## Environment

| Variable | Default | What |
|---|---|---|
| `EMAIL_TRANSPORT` | unset | `ses`, `smtp` or `memory` (tests). |
| `EMAIL_FROM` | unset | The sender, for example `GetWorkDone <noreply@example.com>`; an SES-verified identity when `ses`. |
| `AWS_REGION` | SDK default | SES's region. |
| `SMTP_URL` | unset | Needed for `smtp`. A secret: it carries the password. |
| `QUOTA_DELIVERIES_PER_TEAM_PER_HOUR` | 500 | Webhook and email attempts per team an hour; past it, deliveries are deferred (Retry policy). |
| `QUOTA_EXPORTS_PER_TEAM_PER_HOUR` | 20 | Exports per team an hour (Exports). |
| `QUOTA_TEAMS_PER_SUBJECT_PER_DAY` | 5 | Teams one subject creates a day ([domain.md](domain.md) "Limits and quotas"). |
| `QUOTA_WORK_TYPES_PER_TEAM` | 50 | Work types per team, a cap ([domain.md](domain.md)). |
| `QUOTA_ITEMS_PER_SUBJECT_PER_MINUTE` | 60 | Items one subject submits a minute ([capture.md](capture.md)). Not enforced under `NODE_ENV=test` unless a test passes limits, like the worker. |
| `DELIVERY_POLL_MS` | 5000 | How often the worker looks for due deliveries; it also looks at boot and when an item completes. The worker does not run under `NODE_ENV=test`, where tests drive it (see Test isolation). |

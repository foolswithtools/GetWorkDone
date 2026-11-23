# Sign-in and authorization

GetWorkDone signs people in with OpenID Connect (GWP#3, spec §4.3, §7.3). The code is issuer-agnostic: the sandbox uses Amazon Cognito (D-040), the tests a local mock issuer, and another identity provider plugs in behind one interface. Decisions are cited by number from the program register (spec §9.4) and never copied here.

## The flow

```
browser                         API                                   issuer
  | GET /auth/login              |                                       |
  |----------------------------->| new state, nonce, PKCE verifier;      |
  |                              | LoginAttempt row (10 min, single use) |
  |<-- 302 to authorize, ---------| Set-Cookie __Host-gwd_login           |
  |    Set-Cookie                |                                       |
  |    __Host-gwd_login          |                                       |
  |---------------------------------------------------------------------->| sign in
  |<---------------------------------------------- 302 /auth/callback?code&state
  | GET /auth/callback?code&state (__Host-gwd_login sent: SameSite=Lax, top-level GET)
  |----------------------------->| take the LoginAttempt (deleted as read)|
  |                              | state must match, else 400            |
  |                              | POST token endpoint: code + verifier ->|
  |                              |<--------------------------- id_token  |
  |                              | verify signature (JWKS), iss, aud,    |
  |                              | exp, nonce; else 401                  |
  |<-- 302 /, Set-Cookie --------| Session row (8 h absolute)            |
  |    __Host-gwd_session        |                                       |
  | GET /api/v1/me               |                                       |
  |----------------------------->| identity, csrfToken, teams            |
```

1. `GET /auth/login` makes a fresh `state`, `nonce` and PKCE `code_verifier`, stores them in a `LoginAttempt` row and sets the `__Host-gwd_login` cookie, then redirects to the issuer's authorization endpoint (from discovery) with `response_type=code`, `scope=openid email profile`, `code_challenge` and `code_challenge_method=S256`. With no provider configured it answers 503; if discovery fails, 503.
2. The issuer sends the browser to `GET /auth/callback?code=...&state=...`. The `LoginAttempt` behind `__Host-gwd_login` is deleted as it is read, so a callback works once. A missing sign-in (including a `gwd_login` cookie without the prefix), a `state` that does not match, an `error` from the issuer or a missing `code` is 400.
3. The API redeems the code at the token endpoint with the verifier (client authentication `client_secret_basic`, or `client_secret_post` when the issuer offers only that) and verifies the ID token: the signature against the issuer's JWKS (refetched once when a `kid` is unknown, for key rotation; `none` and HMAC algorithms refused), `iss` equal to the discovered issuer (discovery must name this issuer, and https endpoints), `aud` containing `OIDC_CLIENT_ID` (and `azp` equal to it when there are several audiences), `exp` and `iat` present and `exp` not passed (30 s clock tolerance), `nonce` equal to the one stored, and `sub` and `email` present. Any failure is 401 and no session starts.
4. If the browser sent a `__Host-gwd_session` cookie, the session behind it is deleted, whoever it belonged to (GWP#56, "Cookies and sessions" below). A new `Session` row is written and `__Host-gwd_session` set; the browser goes to `/`.
5. `POST /auth/logout` deletes the session row and clears the cookie (204, also with no session). `POST /auth/logout/all` ("Sign out everywhere", GWP#56) deletes every `Session` row of the signed-in subject, on every device and browser, in one `deleteMany` through the `subject` index, and clears the cookie (204); without a valid session it is 401. Neither ends the session at the issuer.

The code is in `apps/api/src/modules/identity` (the interface and providers) and `apps/api/src/modules/auth` (routes, cookies, sessions).

## Cookies and sessions

| Cookie | Holds | Attributes |
|---|---|---|
| `__Host-gwd_session` | a random 256-bit token | `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800` (8 hours) |
| `__Host-gwd_login` | a random 256-bit token, during sign-in only | `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600` |

- Both names carry the `__Host-` prefix (GWP#17, D-087). A browser keeps a `__Host-` cookie only if it is `Secure`, `Path=/` and has no `Domain`, so a sibling host on a parent domain GetWorkDone shares cannot set one to force a sign-in (login CSRF) or shadow a session. The API reads only the prefixed names: an unprefixed `gwd_login` or `gwd_session`, which a sibling could set with `Domain=<parent domain>`, is ignored, so `/auth/callback` answers 400 and `/api/v1` 401. The prefix is why the login cookie is `Path=/` rather than `/auth`. A session under the earlier `gwd_session` name ends at the deploy that ships the rename.

- Both rows (`Session`, `LoginAttempt`, migration `packages/db/prisma/migrations/20261021180000_sessions`) are keyed by the SHA-256 of the cookie token, so the database never holds a usable cookie.
- A sign-in replaces the browser's session (GWP#56): when `GET /auth/callback` carries a `__Host-gwd_session` cookie, its row is deleted just before the new one is written, whatever subject it belonged to, so a sign-in on a shared browser leaves no earlier person's session valid. The deletion follows the code's verification: a refused or abandoned sign-in (400, 401) leaves the presented session as it was. The same person's sessions in other browsers are left alone; "Sign out everywhere" ends those. Other tabs of the same browser share the new cookie but still hold the old session's CSRF token from `GET /api/v1/me`, so their writes are 403 until they reload.
- The session expiry is absolute: 8 hours from sign-in, never extended. A session presented after `expiresAt` is 401 and its row is deleted then.
- A periodic purge (`apps/api/src/modules/auth/session-purge.ts`, GWP#16) deletes every `LoginAttempt` and `Session` row at or past `expiresAt`, through the `expiresAt` indexes, every ended sign-in rate window (`LoginRateWindow`, below; GWP#32) and every quota window whose `windowStart + windowMs` has passed (`QuotaWindow`, GWP#50, [domain.md](domain.md) "Limits and quotas") and every `Identity` past its retention (GWP#143, "Team membership" below). It runs inside the API process at startup and then every `SESSION_PURGE_MS` (15 minutes by default); several tasks purging at once is safe. On a fresh instance it first waits for its tables (GWP#101): it checks for `Identity`, the newest of the five, at once and then every minute, logs `session purge waiting for the database schema` once at `warn` and `session purge started` when the table exists. Each run is an `auth.session_purge` span, a log line `session purge` with `login_attempts_deleted`, `sessions_deleted`, `login_rate_windows_deleted`, `quota_windows_deleted` and `identities_deleted`, and the RED metrics `session_purge_runs_total{status}`, `session_purge_duration_seconds{status}` and `session_purge_rows_deleted_total{table}` (`LoginAttempt`, `Session`, `LoginRateWindow`, `QuotaWindow`, `Identity`; `recordSessionPurge` in `@getworkdone/telemetry`). A failed run is logged (`session purge failed`), counted with `status="error"` and tried again on the next interval. If GWP#8 moves scheduled work out of the process, `SessionPurge.runOnce` is the entry point.
- `Secure` is always set. Browsers accept it on `http://localhost`, which is how local runs and the e2e spec work; use `localhost`, not `127.0.0.1`, locally.

## Sign-in rate limit

`GET /auth/login` writes a `LoginAttempt` row before anyone has signed in, so it is limited per client (`apps/api/src/modules/auth/login-rate-limit.ts`, GWP#16): one address may start `LOGIN_RATE_LIMIT` sign-ins a minute (20 by default), counted from its first call in the window. Past that the route answers 429 with `Retry-After` (seconds) and writes nothing. IPv4 addresses count one by one; IPv6 addresses count by their /64.

- The address is Express's `req.ip`. With `TRUST_PROXY_HOPS` unset it is the socket peer, which behind the ALB is the ALB itself, so every client would share one count. The deploy (GWP#8) must set `TRUST_PROXY_HOPS=1` behind the one ALB, and keep the ALB's `X-Forwarded-For` handling at `append` (its default; `preserve` would pass a client's own header through): `req.ip` is then the last `X-Forwarded-For` entry, the address the ALB saw, which a client cannot forge by sending its own header. Set it only when the API is reachable through the proxy alone.
- The count is kept in Postgres (`LoginRateWindow`, one row per key, migration `packages/db/prisma/migrations/20261024000000_login_rate_windows`, GWP#32), so every API task shares it and a restart keeps it: however many tasks run, one address starts at most `LOGIN_RATE_LIMIT` sign-ins a minute. Each call is one `INSERT ... ON CONFLICT DO UPDATE` on the key's row, so calls racing through different tasks are counted one by one. The window's start comes from the clock of the task that opened it.
- If the count cannot be read or written (the database is unreachable), `GET /auth/login` answers 503 and logs `sign-in rate limit store unavailable`; it never skips the limit.
- The session purge deletes windows that ended (`windowStart` a minute old or more), so the table holds at most the keys seen in the last purge interval and a minute.

## Authorization

Global guards in `apps/api/src/common`, run in this order (`common.module.ts`):

1. **Deny by default** (`deny-by-default.guard.ts`, from GWP#2): reads `__Host-gwd_session`, and with an unexpired session sets the identity on the request. Every `/api/v1` route without one is 401. `/healthz`, `/auth` and the SPA stay open.
2. **CSRF** (`csrf.guard.ts`): a request with a session and a method other than GET, HEAD or OPTIONS must send the session's CSRF token in `X-GWD-CSRF`, or it is 403. This covers `/api/v1` writes, `POST /auth/logout` and `POST /auth/logout/all`. The SPA reads the token from `GET /api/v1/me` (`apps/web/src/auth/api.ts`).
3. **Team membership** (`team-member.guard.ts`): any `/api/v1` route with a `:teamId` parameter needs a `TeamMember` row for the session's subject in that team, or it is 403 before the handler reads anything; a team that does not exist is 403 the same way. A handler or controller marked `@RequireTeamRole('admin')` (the work-type writes, the members routes, and an item's retry, resume, data edit and cancel) also needs the `admin` role.

`GET /api/v1/me` returns `{ subject, email, displayName?, csrfToken, teams: [{ id, name, role }], r4c? }` (`MeResponse` in `@getworkdone/contracts`). `r4c` is `{ appId }`, present only when the instance has a request-4-change signing key: the SPA then embeds the widget with that `app-id` ([r4c.md](r4c.md), GWP#10).

## Team membership

A team's members are `TeamMember` rows: a subject and a role, `member` or `admin` (GWP#20). Whoever creates a team is its first admin. Admins manage the rest through three routes (`apps/api/src/modules/teams/members.controller.ts`), all marked `@RequireTeamRole('admin')`, so anyone else in the team, or outside it, is 403 before the handler runs:

| Route | Body | Answers |
|---|---|---|
| `GET /api/v1/teams/:teamId/members` | | 200, `[{ subject, role, createdAt, email, displayName }]`, oldest first (`TeamMemberResponse`); `email` and `displayName` are null for a member who has not signed in (GWP#99) |
| `POST /api/v1/teams/:teamId/members` | `{ subject, role }` (`AddTeamMemberRequest`; the subject is trimmed, 1 to 255 characters; no other keys) | 201 with the new member, as the list shows it; 409 when the subject is already in the team, whatever its role; 400 for a malformed body |
| `DELETE /api/v1/teams/:teamId/members/:subject` | | 204; 404 when the subject is not in the team; 409 when it is the team's last admin, and the row stays |

- The subject is what the identity provider returns as `sub` (and what `GET /api/v1/me` shows as `subject`). The admin types it; there are no email invitations and no directory lookup. A member reads their subject in their own header after signing in ("Signed in as ...", beside their email, with a Copy subject button where the browser offers the clipboard API; the subject is selectable text either way, GWP#49) and passes it to an admin. A subject that has never signed in can be added, and sees the team when it first signs in. In the path, the subject is URL-encoded (`auth0%7C123` for `auth0|123`); a subject of exactly `.` or `..` cannot be removed from a browser, which resolves those segments before sending.
- **Names and emails (GWP#99).** Every sign-in upserts the person's `Identity` row (`SessionsService.create`, in the transaction that writes the session): their email and display name exactly as this sign-in's ID token asserted them, the display name being the `name` claim, else `preferred_username`, else null (`oidc.provider.ts`). So the values refresh at every sign-in, and a name the provider no longer asserts becomes null. `Identity` is keyed by subject, not team: one sign-in updates every team the person is in, and removing a member leaves it. The members list and the add's answer join it by subject; a member who has never signed in, or not since the migration (`20261102120000_identity_profile`, no backfill), shows `email` and `displayName` null until their next sign-in. Only the members routes, which are admin-only, return these fields, and nothing an admin sends writes them: the add form takes a subject and a role only.
- **Retention (GWP#143).** An `Identity` is kept while its subject is in any team or has an unexpired session, and for 90 days after its last sign-in (`updatedAt`, `IDENTITY_RETENTION_MS` in `sessions.service.ts`). Once all three have lapsed, the session purge deletes it (above, through the `updatedAt` index, migration `20261103000000_identity_retention`). So someone who signed in once and never joined a team, or who was removed from every team, is gone 90 days after their last sign-in; a member of any team keeps theirs, and the members panel keeps their name. A subject added to a team after its `Identity` went shows `email` and `displayName` null until it next signs in, as one that has never signed in does; that includes a member last seen over 90 days ago whose role is changed by removing and adding them, if a purge runs in between. A sign-in racing the purge either refreshes `updatedAt` first, and the row stays, or writes the row again. Erasing `ItemEvent.actorSubject` (append-only) and deleting one's own profile are out of scope.
- A team always keeps an admin. The removal takes the team's row lock (`SELECT ... FOR NO KEY UPDATE` on `Team`, as exports do), then reads the member and counts the admins, so two admins removing each other at once cannot both succeed: the second waits, counts one admin and is 409. An admin may remove themself while another admin remains; they lose the team at once, and the SPA takes them back to their team list.
- The role is checked once per request, before the handler (the team-member guard), as on every admin route: a request from an admin that is already past the guard when that admin is removed still completes.
- There is no route to change a role: remove the member and add them again.
- In the SPA, anyone signed in creates a team with the **Create a team** form under their team list (`apps/web/src/auth/Auth.tsx`, GWP#49): the submit stays disabled while the trimmed name is empty, a name the API refuses (over 120 characters) shows its message under the input, and a created team opens at once with its creator as admin. An admin opens **Members** on the team page (`apps/web/src/teams/Members.tsx`) to see the list, add a subject with a role, and remove a member; a refusal shows the API's message. Each row leads with the member's display name, else their email, else their subject, and keeps the subject beside a name or email as selectable text (GWP#99). The **Subject** label and the help text say a member finds their subject on the "Signed in as" line of their own header.

## Configuration

| Variable | What |
|---|---|
| `IDENTITY_PROVIDER` | `oidc` (default) or `fake`. `fake` starts only when `NODE_ENV=test`; any other value of `NODE_ENV`, or none, stops startup. |
| `OIDC_ISSUER_URL` | The issuer identifier; discovery is `<issuer>/.well-known/openid-configuration`. Must be https (http is allowed on loopback, for tests). |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | The app client. The secret comes from Secrets Manager in deployed environments (GWP#8). |
| `OIDC_REDIRECT_URI` | This app's `https://<host>/auth/callback`, exactly as registered with the issuer. |
| `LOGIN_RATE_LIMIT` | Sign-ins one client address may start a minute, across all API tasks; 20 when unset or not a positive whole number (GWP#16, GWP#32). |
| `TRUST_PROXY_HOPS` | Proxies in front of the API to trust for the client address (Express `trust proxy`): 0 by default, `1` behind the ALB. Anything but a whole number stops startup (GWP#16). |
| `SESSION_PURGE_MS` | How often the purge of expired sign-ins and sessions runs, in milliseconds; 900000 (15 minutes) when unset or not a positive whole number. The purge does not run under `NODE_ENV=test` (GWP#16). |

With none of the four `OIDC_` variables set, the API still starts: `/auth/login` answers 503 and every `/api/v1` route stays 401, so a deploy made before the issuer exists exposes nothing. Setting only some of them stops startup with the names of the missing ones.

### Amazon Cognito in the sandbox (D-040)

The sandbox's data stage (GWP#43, `deploy/sandbox/data`) creates each instance's user pool and app client, and writes the issuer URL and client id to its `/getworkdone/<instance>/data/` parameters and the client secret to `getworkdone/<instance>/oidc`. The app stage (GWP#8, `deploy/sandbox/app`) sets `OIDC_ISSUER_URL` and `OIDC_CLIENT_ID` from those parameters, `OIDC_CLIENT_SECRET` from that secret (an ECS secret, never plain text) and `OIDC_REDIRECT_URI` to `https://<instance hostname>/auth/callback`, the client's one callback (`docs/deploy/sandbox.md`). The Cognito issuer URL has the shape

```
https://cognito-idp.<region>.amazonaws.com/<user-pool-id>
```

(for example `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEfGhI`; the real pool id is set in the environment, never in this repo, D-035). The app client needs a client secret, the authorization code grant, the `openid`, `email` and `profile` scopes, and `OIDC_REDIRECT_URI` as an allowed callback URL. Cognito publishes discovery and its JWKS under the issuer URL and supports `client_secret_basic`, so no Cognito-specific code is needed.

Sign-in policy of the sandbox pools (`deploy/sandbox/data/identity-email.tf`): only the owner creates users (`allow_admin_create_user_only`), and the email address is the user name.

- **MFA: not yet required.** GWP#56 asked for `mfa_configuration = "ON"` with an authenticator app (TOTP, no SMS). It is moved to GWP#130: the live k6 smoke and the alert drill sign in to the real pool with a password only (`tests/k6/lib/cognito.js`), and under `ON` every user, theirs included, is sent to authenticator enrolment, so the change would turn the live smoke red on its first apply. GWP#130 waits for the owner's choice of how k6 answers the code prompt.
- **Threat protection: off, an accepted risk** (GWP#56). Cognito's threat protection (`user_pool_add_ons { advanced_security_mode = "AUDIT" | "ENFORCED" }`: compromised-credential checks and risk-based blocking of sign-ins) moves a pool to the billed Plus feature plan. The sandbox keeps the program's free-tier cost posture (D-042's choice for Grafana Cloud is the precedent), so neither pool has the add-on, and the tftest checks that the block stays absent until the owner decides otherwise. The risk accepted: a leaked or guessed password for an owner-created user is not flagged or blocked by Cognito; the exposure is limited to the few users the owner creates, each of whom only sees the teams they are a member of. The owner may object on GWP#56, and a change is filed only if asked.

## Plugging in another identity provider

Sign-in sits behind `IdentityProvider` in `apps/api/src/modules/identity/identity.ts`:

- `authorizationUrl({ state, nonce, codeChallenge })` returns where to send the browser.
- `exchangeCode({ code, nonce, codeVerifier })` returns a `VerifiedIdentity` (`subject`, `email`, optional `displayName`) or throws an `IdentityError` with a fixed `reason` (logged, never containing a token).

Any standards-compliant OIDC issuer (for example Okta, Entra ID, Auth0 or Keycloak) needs only the four variables. A provider that is not OIDC implements the interface in a new file under `apps/api/src/modules/identity` and is added as a new `IDENTITY_PROVIDER` name in `identity.module.ts`. The `subject` it returns is what `TeamMember.subject` matches, so it must be stable for a person.

## Logs

The redacting logger (`packages/telemetry/src/logger.ts`) removes JWTs, bearer and `Authorization` values written as text (JSON-quoted too), `__Host-gwd_session` and `__Host-gwd_login` values in cookie text (and the unprefixed names), and OIDC codes, PKCE verifiers, client secrets and tokens in a URL query, fragment or form body, as well as any value under a sensitive key (including `id_token`, `access_token`, `refresh_token`, `code_verifier`, `gwd_session`, `gwd_login`, `__Host-gwd_session` and `__Host-gwd_login`). Sign-in logs only the provider, the subject and a refusal's reason. The e2e spec (`tests/e2e/sign-in.spec.ts`) checks the API's log output holds no `eyJ`.

## Tests

| Test | Partition | Covers |
|---|---|---|
| `apps/api/test/oidc.provider.test.ts` | unit | The relying party against the mock issuer (`apps/api/test/support/mock-issuer.ts`): wrong `aud`, wrong `iss`, expired, bad signature, `nonce` mismatch, missing PKCE verifier, key rotation, discovery |
| `apps/api/test/auth.test.ts` | unit | Routes, guards and sessions with the database stubbed; the callback deletes a presented session before it creates the new one, and keeps it when the sign-in fails; `logoutAll` deletes by subject, 401 without a session; `deleteForSubject` is one `deleteMany` (GWP#56); the 21st `GET /auth/login` in a minute from one address is 429, the guard answers 503 when the rate store throws, `TRUST_PROXY_HOPS` parsing; `purgeExpired` returns the `Identity` count beside the others, with the retention rule's delete last (GWP#143) |
| `apps/api/test/session-purge.test.ts` | unit | The purge's schedule, overlap, shutdown and failure handling; its log line carries each table's count, `identities_deleted` included (GWP#143) |
| `apps/api/test/fake-provider-guard.test.ts` | unit | The fake provider stops startup outside `NODE_ENV=test` |
| `apps/api/test/auth.integration.test.ts` | integration | Cookie attributes (`__Host-` names, `Secure`, `Path=/`, no `Domain`), unprefixed `gwd_login` 400 and `gwd_session` 401, state mismatch 400, cross-team 403 with no `ItemEvent` written, member 403 on a work-type write, CSRF 403, logout, expiry; a second sign-in in one browser ends the first session, of the same or another subject, and leaves the same subject's other browser alone; `POST /auth/logout/all` ends both sessions of a subject and not a third subject's, is 403 without `X-GWD-CSRF` and deletes nothing, and is 401 without a session (GWP#56); 100 rapid `GET /auth/login` calls write at most 20 `LoginAttempt` rows, also split across two apps on one database (15 through each of two apps give 20 redirects and 10 answers of 429), a restarted app keeps the count, an unreachable database gives 503, the Postgres store's window, and the count follows `X-Forwarded-For` only behind a trusted proxy |
| `apps/api/test/session-purge.integration.test.ts` | integration | Expired `LoginAttempt` and `Session` rows and ended `LoginRateWindow` and `QuotaWindow` rows are deleted and the rest stay; after a run none is past `expiresAt`; an `Identity` 91 days past its sign-in with no team and no live session is deleted, while one with a `TeamMember` row, an unexpired `Session` or an 89-day-old sign-in stays (GWP#143) |
| `packages/telemetry/src/logger.test.ts` | unit | JWT, `Authorization` value, sign-in cookie and OIDC code redaction |
| `tests/e2e/sign-in.spec.ts` | e2e | Sign in through the mock issuer, see the team list, sign out; a real sign-in token under the unprefixed `gwd_login` name is a 400 on `/auth/callback` |
| `tests/e2e/sign-out-everywhere.spec.ts` | e2e | One person signed in in two browser contexts; "Sign out everywhere" asks first (staying signed in changes nothing), and once confirmed the other context's reload lands on the signed-out view and its `/api/v1/me` is 401 (GWP#56) |
| `apps/web/src/auth/api.test.ts` | unit | The SPA's sign-in calls: `/api/v1/me`, the CSRF header on writes, `POST /auth/logout` and `POST /auth/logout/all` (GWP#56) |
| `apps/api/test/members.integration.test.ts` | integration | Team membership (GWP#20): an added member sees the team in `GET /api/v1/me` and reads its work types; a non-admin is 403 on every members route; a second add is 409; a removed member loses the team; removing the last admin is 409 and keeps the row; a removal waits on the team's row lock and re-counts the admins after it |
| `apps/api/test/members-profile.integration.test.ts` | integration | Members by name (GWP#99): a sign-in upserts `Identity` and a later one updates (or clears) the name, and moves `updatedAt` even when nothing changed (GWP#143); two first sign-ins at once leave one row; the list and the add answer carry `email` and `displayName`, null for a member who has not signed in; a non-admin and an outsider are 403; a removal leaves `Identity`; one sign-in shows in every team |
| `apps/api/test/domain-services.test.ts` | unit | The members queries are scoped by `teamId`; a duplicate is 409, the last admin 409, an unknown subject 404; each member is matched to its `Identity` by subject (GWP#99) |
| `packages/contracts/src/api-v1.test.ts` | unit | `TeamMemberResponse` takes null for `email` and `displayName` and refuses a body without either (GWP#99) |
| `apps/web/src/teams/api.test.ts` | unit | The SPA's member calls: paths, the encoded subject, DELETE with the CSRF header; `createTeam` (GWP#49): `{ name }` with the CSRF header, a 400's issues keyed `name`, a 403 as one form message |
| `tests/e2e/builder-capture.spec.ts` | e2e | The admin creates the team with the form, adds the capture member in the members panel, sees a second add refused, removes a mistaken subject, and cannot remove the last admin |
| `tests/e2e/teams.spec.ts` | e2e | Team creation and the signed-in subject (GWP#49): a fresh user creates a team (submit disabled for a blank name) and lands on it as admin; a second user's header shows their issuer `sub` and email, Copy subject puts it on the clipboard, and the admin adds them by it, after which both rows lead with the issuer's `name` and still show the subject, a user with no `name` claim leads with their email, and a subject that has never signed in shows only itself (GWP#99); a 121-character name shows an error under the input and creates no team; a failed reread of `/api/v1/me` after a create still opens the new team |

Integration tests sign in through the real routes with the fake provider (`apps/api/test/support/identity.ts`; `vitest.shared.ts` sets `IDENTITY_PROVIDER=fake`).

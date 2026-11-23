# The request-4-change widget

GetWorkDone hosts request-4-change's widget, so a signed-in user can ask for a change to GetWorkDone from inside it (GWP#10; spec §3.9 and §4.2, D-017, D-018, D-033). Three parts make it work:

- the API signs a short-lived **requester assertion** for the signed-in user and publishes the public key;
- the SPA embeds `<r4c-widget>` and maps its six styling tokens onto the theme;
- request-4-change's **edge** runs as a sidecar in the API's task, and the load balancer sends `/__r4c/*` on the instance's hostname to it, so users see one site.

The widget contract is request-4-change's: foolswithtools/request-4-change-private `docs/widget-contract/v1.md` (version 1.0.0), with the assertion rules in foolswithtools/request-4-change-private `docs/security/requester-assertion.md`.

## The app id

Each instance is its own host app in request-4-change, and its app id is the instance's environment label, `GETWORKDONE_ENVIRONMENT`: `getworkdone-dev` or `getworkdone`. It is the token's `app_id` claim, edge's `R4C_APP_ID` and the element's `app-id`, and all three must agree. It is not `GETWORKDONE_INSTANCE` (`dev`, `prod`): request-4-change keys host apps by app id across every host, so a bare `dev` would collide with another host's. Unset (local development), the app id is `local`, as telemetry's default environment is.

## The token: `GET /api/v1/r4c/token`

The widget's `token-url`. It is under `/api/v1`, so the deny-by-default guard answers a JSON 401 without a session before the handler runs (`apps/api/src/common/deny-by-default.guard.ts`), and the widget's `redirect: 'error'` never meets a redirect. The answer is `{"token":"<jwt>"}` with `cache-control: no-store`.

The JWT (`apps/api/src/modules/r4c/signing-key.ts`):

| Part | Value |
|---|---|
| `alg` | `ES256` |
| `kid` | the public key's RFC 7638 thumbprint (SHA-256) |
| `typ` | `JWT` |
| `sub` | the session's subject (the OIDC `sub`) |
| `email` | the session's email |
| `roles` | the distinct `TeamMember.role` values of the subject across its teams, sorted: `["admin"]`, `["admin","member"]`, `["member"]` or `[]` |
| `app_id` | the app id above |
| `iat` | now, in seconds |
| `exp` | `iat` + 120 |

**Why 120 seconds.** Edge and control refuse an `exp` more than 300 s ahead and allow no clock skew for that rule, so a 300 s token fails on a host clock one second ahead of edge's. 120 s is what request-4-change's own demo host uses, and the widget fetches a fresh token for every submit.

Team ids are not in the token: `roles` is opaque to request-4-change, and team ids are GetWorkDone's tenancy.

| Answer | When |
|---|---|
| 200 `{"token":"…"}` | a session, and the instance has a key |
| 401 | no session (the guard) |
| 503 `{"error":"r4c_not_configured"}` | a session, but `R4C_SIGNING_KEY` is unset |

## The key set: `GET /.well-known/r4c-jwks.json`

Open (outside `/api/v1`), with `cache-control: public, max-age=300`: `{"keys":[{"kty":"EC","crv":"P-256","x":"…","y":"…","alg":"ES256","use":"sig","kid":"…"}]}`, the public key only (never `d`), or `{"keys":[]}` when the key is unset. The SPA fallback answers 404 for a path whose last segment has a dot, so `R4cModule` is imported ahead of `SpaModule` (`apps/api/src/app.module.ts`). Edge reads this URL from `R4C_HOST_JWKS_URL`, and control from the host app's registration; both need HTTPS.

## `GET /api/v1/me` and the embed

`MeResponse` (`packages/contracts/src/api-v1.ts`) carries `r4c: { appId }` only when the instance has a key. That is how the SPA knows whether to show the widget, and which `app-id` to set, without a second request.

When `me.r4c` is present, the signed-in page (`apps/web/src/auth/Auth.tsx`, `apps/web/src/r4c/R4cWidget.tsx`):

1. appends `<script type="module" src="/__r4c/widget.js">` to the head once (`apps/web/src/r4c/widget.ts`). It is added at run time, not written into `index.html`: the file exists only behind the load balancer, so the Vite build must not try to resolve it, and a signed-out visitor never loads it;
2. renders `<r4c-widget app-id="<appId>" token-url="/api/v1/r4c/token">`;
3. listens on `document` for `r4c-submitted` and `r4c-error` and shows the request id, or the error code (with `Retry-After` when given), beside the widget.

The API serves nothing under `/__r4c/`: the SPA fallback refuses that prefix (`apps/api/src/spa/spa.controller.ts`, `isReservedPath`; regression in `apps/api/test/spa.test.ts`).

## Styling tokens

`apps/web/src/styles/r4c-tokens.css`, imported from `apps/web/src/main.tsx` after `base.css` (Vite bundles both into the one built stylesheet), sets the widget's six tokens on `r4c-widget` from the theme ([web.md](web.md)):

| Widget token | Value |
|---|---|
| `--r4c-font-family` | `var(--gwd-font-family)` |
| `--r4c-color-fg` | `var(--gwd-color-fg)` |
| `--r4c-color-bg` | `var(--gwd-color-bg)` |
| `--r4c-color-accent` | `var(--gwd-color-accent)` |
| `--r4c-radius` | `var(--gwd-radius)` |
| `--r4c-spacing` | `var(--gwd-spacing)` |

It holds no colour of its own, so the widget follows the dark scheme too. `apps/web/src/styles/r4c-tokens.test.ts` checks the mapping.

## Content-Security-Policy

The API's policy ([security.md](security.md)) admits the widget with nothing added: the script is a same-origin module (`script-src 'self'`); the token GET and the widget's `POST /__r4c/api/requests` are same-origin (`connect-src 'self'`); and the widget adopts a constructed stylesheet in its shadow root, which `style-src` does not govern, so `style-src 'self'` needs no `'unsafe-inline'`. It does so from request-4-change `0.2.0`; keep the edge image at `0.2.0` or later, which `deploy/sandbox/app/tests/r4c.tftest.hcl` checks (#107). Only a browser without `adoptedStyleSheets` gets the widget unstyled, a residual request-4-change records. Edge's own responses under `/__r4c/` carry edge's headers, not the API's.

## The signing key

`R4C_SIGNING_KEY` is the instance's ES256 private key as an unencrypted PKCS#8 PEM, one key per instance. Generate it with:

```sh
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt > r4c-signing-key.pem
```

In a deploy, the maintainers put it into the instance's Secrets Manager secret, which the task reads at start; the deploy pipeline can neither read nor write it (D-075, D-078). The steps are in the maintainers' deploy notes. Delete the PEM file afterwards; never commit it.

- **Unset or empty:** the API starts; the token route is 503 `r4c_not_configured`, the key set is empty and `GET /api/v1/me` has no `r4c`, so the SPA shows no widget. This is local development and every CI partition.
- **Set, but not a PKCS#8 EC P-256 key** (an RSA key, a SEC1 `EC PRIVATE KEY`, another curve, an encrypted key, anything else): startup fails with an error that names `R4C_SIGNING_KEY` and what is wrong, never the value. No log line, error or test output carries the key.

### Rotation

Put a new key and force a new deployment of the service. The API publishes only the key it holds, under a new `kid`; edge and control refetch the key set when a token names an unknown `kid` (at most every 30 s), and an assertion signed with the old key expires within 120 s. During the rollout the old and new tasks publish different keys, so a submit can get `invalid_assertion` for a short while; it succeeds once the rollout completes.

## Edge and the path route

Edge is request-4-change's server image with `R4C_ROLE=edge`, pinned by digest (D-022), as a sidecar of the API's task: stateless and with no secrets (D-017). It listens on 8090 (the task shares one network namespace, and the API holds 8080), and the app-service module's `sidecar_routes` gives it its own target group, health-checked at `/__r4c/healthz`, and a host plus path rule for `/__r4c/*` ahead of the host-only rule (D-018). Its settings: `R4C_APP_ID` (the app id), `R4C_HOST_JWKS_URL` (`https://<instance hostname>/.well-known/r4c-jwks.json`), `R4C_CONTROL_URL` (control's base URL, a deploy variable, D-072), `R4C_DEPLOYMENT_ENVIRONMENT` and `R4C_INSTANCE`, and `OTEL_EXPORTER_OTLP_ENDPOINT` set to the Alloy sidecar (D-027), so edge's spans and metrics reach the same stack as `service.name` `request-4-change-edge` ([observability.md](observability.md)).

Each instance is registered once with request-4-change control (`host-app add` with its app id and key-set URL), after the instance serves its key set; the steps are in the maintainers' deploy notes. Control has no command to remove a host app or change its URL: a wrong registration is fixed by publishing the right keys at the registered URL.

## Tests

| Test | Partition | What |
|---|---|---|
| `apps/api/test/r4c.test.ts` | unit | key parsing and refusals, the `kid`, a minted token verified against the served key set, the 503 and the empty key set, the route ahead of the SPA fallback |
| `apps/api/test/r4c.integration.test.ts` | integration | 401 without a session, `sub`, `email` and `roles` from the database, `me.r4c` with and without a key |
| `apps/web/src/r4c/widget.test.ts` | unit | the script is added once; the events are shown |
| `apps/web/src/styles/r4c-tokens.test.ts` | unit | the six tokens come from the theme |
| `tests/e2e/r4c.spec.ts` | e2e | the built SPA embeds the element only with `me.r4c`, under the enforced CSP, against a stand-in `widget.js` |

The live check against a deployed instance with the real widget and edge files a real request with control on every run, so it is the maintainers' to run after a deploy, never CI's.

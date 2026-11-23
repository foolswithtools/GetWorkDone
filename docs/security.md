# Security response headers

Every response the API sends carries one fixed set of security headers (GWP#48, spec §4.2, §4.3, §7.3). `securityHeaders()` in `apps/api/src/common/security-headers.ts` sets them; `createApp` registers it after the request span and the RED start and before the static files, so the built JS and CSS files, every Nest route, the SPA fallback, the sign-in 302, the guards' 401 and 403 answers, the body parser's 400 and the JSON 404 all carry them. The static files are served with `redirect: false`: serve-static's directory redirect (`/assets` to `/assets/`) would replace the CSP with its own, so `/assets` falls through to the SPA as `/assets/` does. The values are constants (`SECURITY_HEADERS`, `CONTENT_SECURITY_POLICY`), not configuration: no environment variable changes or turns them off. Decisions are cited by number from the program register (spec §9.4) and never copied here.

They are enforced from the first deploy on `getworkdone-dev`: there is no `Content-Security-Policy-Report-Only` phase and no report endpoint, because nothing collects reports. The e2e listener below catches violations before a deploy instead. No helmet: the set is eight fixed strings.

## The headers

| Header | Value | Why |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Browsers reach the app over HTTPS only, for a year. No `preload`: the hostnames sit under the platform's shared zone, and preload is that zone owner's decision. Browsers ignore the header over plain http, so local and e2e runs are unaffected. |
| `Content-Security-Policy` | the policy below | Scripts, styles, fonts and calls come from the app's own origin only, and no other site may frame it. |
| `X-Content-Type-Options` | `nosniff` | Browsers use the declared content type and never guess one. The export download sets it too ([outputs.md](outputs.md)); `setHeader` replaces, so it is sent once. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Webhook hosts, the issuer and any other site see the origin at most, never the path or query. |
| `X-Frame-Options` | `DENY` | The legacy twin of `frame-ancestors 'none'`, for browsers that predate it. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` | The app uses none of these, so no script on the page may ask for them. |
| `Cross-Origin-Opener-Policy` | `same-origin` | A page on another origin that opens the app gets no handle on its window. |
| `Cross-Origin-Resource-Policy` | `same-origin` | Other origins cannot embed the app's responses (scripts, images, JSON). |

`Cross-Origin-Embedder-Policy` is not set: nothing cross-origin is embedded. Add it when something is.

## The policy

`CONTENT_SECURITY_POLICY`, verbatim. `apps/api/test/headers.test.ts` fails if this block and the constant differ, so change both together.

```csp
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'
```

| Directive | Why |
|---|---|
| `default-src 'self'` | Anything not named below loads from the app's origin only. |
| `script-src 'self'` | No inline script, no `eval`, no other origin. The built `index.html` loads one external module script, which Vite keeps external, so no nonce or hash is needed. |
| `style-src 'self'` | The SPA's only CSS is one linked file under `assets/` (GWP#47, [web.md](web.md)); `index.html` has no `<style>` and the markup no `style=` attribute. React `style` props set CSSOM properties, which `style-src` does not govern. |
| `img-src 'self' data:` | Images from the app and `data:` URLs (small inline images CSS or a component may use). |
| `font-src 'self'` | No font comes from another origin. |
| `connect-src 'self'` | `fetch` reaches the API on the same origin only. Webhooks and the issuer are called by the API, not the browser. |
| `frame-ancestors 'none'` | No page may frame the app, so a signed-in session cannot be clickjacked. |
| `base-uri 'self'` | An injected `<base>` cannot point relative URLs at another origin. |
| `form-action 'self'` | Forms submit to the app only. Sign-in is a link to `/auth/login` answered with a 302 to the issuer, not a form post, and the SPA's forms call `preventDefault` and `fetch`, so the issuer's origin appears nowhere in the policy. |
| `object-src 'none'` | No plugins. |

## The request-4-change widget

The policy admits the widget as its contract stands (spec §4.2, D-018), with nothing added for it:

- `<script type="module" src="/__r4c/widget.js">` is same-origin, so `script-src 'self'` allows it.
- Its calls to `/__r4c/` are same-origin, so `connect-src 'self'` allows them. The `traceparent` header it sends is not governed by CSP.
- It renders in an open shadow root and adopts a constructed stylesheet (`adoptedStyleSheets`), which `style-src` does not govern (widget contract v1, "Styling"), so `style-src 'self'` needs no exception. That holds from request-4-change `0.2.0`, the edge image `deploy/sandbox/app/r4c.tf` pins (#107): `0.1.0`'s widget always wrote its CSS as an inline `<style>`, which this policy refuses, so it rendered unstyled ([known issue](known-issues/2026-10-31-edge-widget-unstyled-under-csp.md)). Only a browser without `adoptedStyleSheets` gets an injected `<style>` instead, which this policy refuses: the widget then works unstyled. Its six tokens come from `src/styles/r4c-tokens.css`, a file the policy allows (GWP#10, [r4c.md](r4c.md)).
- The SPA adds the script element at run time (`apps/web/src/r4c/widget.ts`), as a same-origin `src`, never inline. `tests/e2e/r4c.spec.ts` checks the embed under this policy with `watchCsp`.

The `edge` sidecar's own responses on the `/__r4c/*` path route are not the API's and get no headers from it (GWP#10). The ALB adds none.

## Testing a change

- `apps/api/test/headers.test.ts` (unit): every header with its exact value on the SPA, the SPA fallback, a built file (GET and HEAD), `/assets`, `/healthz`, a 401 from the deny-by-default guard on GET and POST, a body parser 400 and an `/api` 404; the policy has `frame-ancestors 'none'` and no `unsafe-inline`, `unsafe-eval`, `*`, `https:` or report directive; no report-only header; the block above equals the constant.
- `apps/api/test/auth.integration.test.ts` (integration): the CSRF and team-membership 403s and the `/auth/login` 302 carry every header.
- `apps/api/test/export.integration.test.ts` (integration): the download answers `nosniff` once.
- `tests/e2e/support/csp.ts` (e2e): `watchCsp(page)` collects console messages that mention `Content Security Policy` and page errors; `expectNoCspViolations()` asserts there were none. `smoke.spec.ts` (signed-out page), `sign-in.spec.ts` (the redirect round trip and sign-out) and `builder-capture.spec.ts` (forms, builder, capture, members) use it, and so do `process.spec.ts`, `outputs.spec.ts`, `teams.spec.ts` and `styles.spec.ts` (in `afterEach`). Watch every page a spec opens, including those made with `browser.newContext()`. `smoke.spec.ts` also checks the first navigation carries `content-security-policy` and `strict-transport-security` and that the built page has no inline `<script>`.
- By hand: `curl -sI http://localhost:8080/`, `curl -sI http://localhost:8080/api/v1/me` (401) and `curl -sI http://localhost:8080/assets/<built js file>` each print the eight headers.

A change that needs a new source (another origin, `'unsafe-inline'`, a nonce) changes the constant, this page and the tests in one PR, and says why in the table above.

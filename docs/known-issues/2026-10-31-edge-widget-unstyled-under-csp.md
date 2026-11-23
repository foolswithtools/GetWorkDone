# The request-4-change widget rendered unstyled under the API's CSP

Resolved in GWP#107. The widget is served by the `edge` sidecar (#10, `deploy/sandbox/app/r4c.tf`). Nothing was exposed: the policy blocked the style as designed, and the widget still worked.

The owner's live spec run on 2026-10-31 (`tests/live/r4c.spec.ts`, from #105's branch, against `getworkdone-dev`) signed in, loaded the widget and filed a request: edge trace `d3e3d57e81e8427ddf74c9c866c559c8`, `POST /__r4c/api/requests` `202`. It then failed its last assertion, `expectNoCspViolations()`:

```
Applying inline style violates the following Content Security Policy directive 'style-src 'self''. … a hash ('sha256-n0naCC36X/o1Vo8ZyX9mOPNoinbYKjRMWJN8Ea0Q3Xc=') … is required
```

Cause: #10 pinned `request-4-change-server` `0.1.0` (`sha256:56e4d432…`), then the only public image. Its `widget.js` always wrote its CSS into the shadow root as an inline `<style>` through `innerHTML`; the 953-byte CSS hashes to exactly the reported value. The API's `style-src 'self'` ([../security.md](../security.md), #48) refuses inline styles, so the form rendered with no layout. request-4-change-private#77 (2026-10-23) moved the widget to a constructed stylesheet adopted by the shadow root, which `style-src` does not govern, and widget contract v1 ("Styling") was updated to match. This repo's docs described that newer widget, but #77 was not in `0.1.0`.

Why no test caught it: `tests/e2e/r4c.spec.ts` serves a stand-in `widget.js`, so the real widget first ran under this policy in the owner-run live spec.

Fix: request-4-change published `0.2.0` on 2026-11-01 (tag `v0.2.0` on f73c39c, after the live worker gate passed on that commit). `deploy/sandbox/app/r4c.tf` pins its server image, `sha256:7c07f83f…`, whose `/app/widget.js` adopts its CSS with `replaceSync` and keeps the inline `<style>` only for browsers without `adoptedStyleSheets`. Since `0.1.0`, the edge code and the requester-assertion contract did not change. `docs/security.md` and `docs/r4c.md` now say from which release the widget adopts its stylesheet.

Regression tests:

- `deploy/sandbox/app/tests/r4c.tftest.hcl` (partition: unit, the `tofu-test` gate), run `edge_sidecar_dev`: "edge must not be request-4-change-server 0.1.0, whose widget is unstyled under style-src 'self'" failed against the old pin.
- The live check is the owner's next run of the live spec on `getworkdone-dev` after this deploys: it passes in full, including `expectNoCspViolations()`.

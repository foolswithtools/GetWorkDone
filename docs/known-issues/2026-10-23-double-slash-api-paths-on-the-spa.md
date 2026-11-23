# Double-slash /api paths answered by the SPA fallback

Resolved in GWP#15, a follow-up from the GWP#3 whole-branch review. The code predates it (GWP#1, GWP#2). No API data was served.

A GET whose path started with two or more slashes, such as `//api/v1/me` or `//api/v1/teams/<id>/work-types`, answered 200 with the SPA's `index.html`, with or without a session (`curl --path-as-is localhost:3000//api/v1/me` gave `200 text/html`). Express hands the catch-all `req.path` with the slashes intact, and both path checks anchored on one leading slash: `isReservedPath` (`apps/api/src/spa/spa.controller.ts`) did not see the path as `/api`, and `isProtectedPath` (`apps/api/src/common/deny-by-default.guard.ts`) did not see it as `/api/v1`. That broke the rule that `/api/` paths are never the SPA's, and a client or monitor probing a misrouted call got HTML and a 200.

Fix: both checks match on the path with its leading run of slashes collapsed to one (`collapseLeadingSlashes`, `apps/api/src/common/path.ts`). A `//api/v1` GET is now 401 without a session (and a JSON 404 with one, as no route matches), other `//api` and `//__r4c` GETs are a JSON 404, and RED records them under `unmatched`. Repeated slashes elsewhere in the path, and percent-encoded slashes, were out of scope; encoded, dot-segment and backslash spellings of `/api` were fixed later in GWP#30 ([2026-10-24-encoded-and-dot-segment-api-paths-on-the-spa.md](2026-10-24-encoded-and-dot-segment-api-paths-on-the-spa.md)).

Regression tests:

- `apps/api/test/spa.test.ts`, "repeated leading slashes do not reach the SPA: //api/v1 is 401, other //api and //__r4c paths a JSON 404 (GWP#15)".
- `apps/api/test/deny-by-default.test.ts`, "repeated leading slashes do not take a path out of /api/v1 (GWP#15)".
- `apps/api/test/auth.integration.test.ts`, "with a session, a repeated leading slash is a JSON 404, never index.html (GWP#15)".
- `apps/api/test/common.test.ts`, the RED helpers case (`//api/x` is `unmatched`).

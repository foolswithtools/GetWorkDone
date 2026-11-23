# RED double count on a failed response, and body errors answered 404 by the SPA fallback

Resolved before merge, GWP#1. Found by the fresh-context whole-branch review.

## Double count

A handler that returned a value its response could not serialize (a `BigInt`, a circular object) was recorded twice in `http_server_requests_total`: `FinalStatusFilter` recorded the 500, then the response finished and the interceptor's finish listener recorded the same 500 again. That inflates the 5xx ratio every availability SLO and burn-rate alert reads (GWP#7).

Fix: the interceptor and the filter both call `claimRecording(req)` (`apps/api/src/common/red.ts`) before recording; only the first records.

Regression test: `apps/api/test/red.test.ts`, "a response that fails to serialize is recorded once, as 500 (review of GWP#1)".

## Body errors answered 404

`@nestjs/serve-static@5.0.5`'s fallback turned every Express-level error on an excluded path into a `NotFoundException` (`dist/loaders/express.loader.js:93-97`), so a malformed JSON body (400) or an oversized one (413) on any `/api/` route answered 404 "Cannot POST" and was recorded under `unmatched`.

Fix: the library is gone. Built files are served by `useStaticAssets` with fall-through, and the SPA fallback is a catch-all Nest route registered after every other module (`apps/api/src/spa/spa.controller.ts`); it refuses `/api`, `/__r4c` and missing files with a JSON 404. A malformed body is now answered 400 (413 when oversized) by Nest's error handling; it is still recorded under `unmatched`, because the body parser fails before any route matches.

Regression tests: `apps/api/test/red.test.ts`, "a malformed JSON body on an API route is a 400, not a 404 (review of GWP#1)"; `apps/api/test/spa.test.ts`, "a missing asset is a 404, not index.html".

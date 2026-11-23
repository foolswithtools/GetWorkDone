# Capture: a stale version on the capture page, two error shapes, a capped item list

Resolved in GWP#21, follow-ups from the GWP#4 whole-branch reviews (PR #19, [2026-10-21-safe-pattern-bypasses.md](2026-10-21-safe-pattern-bypasses.md)). None blocked that merge.

- **The capture page used a stale version.** It validated against the version it loaded. After an admin saved a newer version, a submit could be refused for a field the form did not show, with the error listed above the form as `priority: Required` and no way to fill it in short of leaving the page. Fix: when the API's errors name a key the form does not know, the page reloads the work type and shows the errors against the new version's fields, keeping what was typed (`namesUnknownKeys`, `apps/web/src/work-types/capture/item-list.ts`; `CaptureForm`'s `keepErrorsWhenFieldsChange`).
- **Two error shapes for an invalid definition.** `POST .../work-types` answered 400 `{ issues }`, `POST .../versions` 422 `{ errors }`. Both now answer 422 `{ errors }` keyed by path, and each parses the definition once (`parseDefinitionBody`, `apps/api/src/common/zod.ts`); the service no longer parses it a second time.
- **The item list stopped at 100.** Items past the newest 100 could not be listed. It now pages with a cursor on `(createdAt, id)`, and the page shows older versions' keys. Found in this branch's own review: a forged cursor that read back as itself but held a value Postgres refuses (a NUL in the id, year 0) was a 500, which counts against the availability SLO; the cursor's id must now be a UUID and its year 0001 to 9999. A Load more still in flight when a submit refreshed the list could write the older list back over it; it is now dropped.
- **A misleading pattern message.** `(?:^)*` and `($)?` are valid regular expressions but were refused as "not a valid regular expression"; the message now says a quantified assertion is not supported.
- **Matchers rebuilt on every submit.** Each version's validator is now compiled once and cached, bounded (`apps/api/src/modules/capture/matcher-cache.ts`).

Regression tests:

- `tests/e2e/builder-capture.spec.ts`: the member's page reloads version 2 after a submit refused for `priority`, shows `Required` under it, shows the older `amount` key in the list, and pages past 100 items with Load more.
- `apps/web/src/work-types/capture/item-list.test.ts`, "namesUnknownKeys" and "olderKeys".
- `apps/api/test/work-types.integration.test.ts`, "POST answers an invalid definition 422 `{ errors }` keyed by path and writes no row".
- `apps/api/test/capture.integration.test.ts`, "pages with a cursor past 100 items, newest first, each item once, rows sharing a timestamp included" and "a cursor that is not one the list gave out is 400" (including the forged cursors).
- `apps/api/test/capture.test.ts`, "two submits on the same version compile its patterns once; a new version compiles its own"; `apps/api/test/matcher-cache.test.ts`.
- `apps/api/test/domain-services.test.ts`, "reviseDefinition checks the steps, then writes the next version; a lost race is a conflict" (the parsed definition is stored as given).
- `packages/contracts/test/pattern-matcher.test.ts`, "refuses a quantified assertion that RegExp accepts, saying so".

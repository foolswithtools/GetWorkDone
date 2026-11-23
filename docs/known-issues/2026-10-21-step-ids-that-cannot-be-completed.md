# A human step with an empty, `.` or `..` id could never be completed

Resolved before merge, GWP#5. Found by the fresh-context whole-branch review.

`ProcessStep.id` (`packages/contracts/src/domain.ts`) is any string, which was harmless while a step id was only a label. GWP#5 made it a URL path segment: `POST /api/v1/teams/:teamId/items/:itemId/steps/:stepId/complete` and `.../retry`. Express never routes an empty segment (`steps//complete` is 404), and fetch and browsers collapse `.` and `..` when they normalise the URL, so the request never reaches the controller. A work type saved through the API with such an id on a human step left every item that reached that step `in_progress` for good: no route could complete it, and retry needs `failed`. The builder's step editor always generates `step_N` ids, so only the API path was exposed.

Fix: the contract's save-time step checks (`stepProblems` in `packages/contracts/src/process.ts`) require every step id, human or automated, to be 1 to 64 letters, digits, dashes and underscores. A definition that breaks the rule is 422 `{ "errors": { "definition.steps.N.id": [...] } }` on both `POST .../work-types` and `POST .../work-types/:id/versions`, and writes nothing. The builder shows the message beside a stored step that breaks it. Stored definitions are not re-checked (they are not re-parsed when read).

Regression tests:

- `apps/api/test/process.integration.test.ts`, "a step id that cannot be a path segment is refused at save with 422, on create and on a new version".
- `packages/contracts/test/process.test.ts`, "a step id that cannot be a URL path segment is refused, for human and automated steps alike".

The same review pinned the process transactions to `READ COMMITTED` (`apps/api/src/modules/process/process.service.ts`), the Postgres default the 409 on a lost race depends on; under `REPEATABLE READ` the losers would have been 500s.

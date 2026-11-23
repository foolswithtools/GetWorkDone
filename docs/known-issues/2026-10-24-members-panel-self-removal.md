# An admin who removed themself saw "Could not load the members"

Resolved before merge, GWP#20. Found by the fresh-context whole-branch review.

The first members panel reloaded the list after every successful removal. When an admin removed themself (allowed while another admin remains), the reload was answered 403, because they were no longer in the team, and the panel showed "Could not load the members". The SPA still treated them as the team's admin until they went back and the team list was read again.

Fix: `Members.tsx` knows the signed-in subject. A successful removal of that subject calls `onLeft`, and `Auth.tsx` closes the team and reads `GET /api/v1/me` again, so the team is gone from the list.

Regression test: `tests/e2e/builder-capture.spec.ts`, "the item list pages past 100 items, and the admin removes themself once there is a second admin", its last step: with a second admin added, the first removes themself and sees the team list without the team (`no-teams`). It fails at `no-teams` with the `onLeft` call disabled.

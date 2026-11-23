# A team at its work-type cap could not add one after archiving, and unarchive skipped the cap

Resolved in GWP#103. Found in the fresh-context whole-branch review of GWP#55, which made archive the retirement path for a work type (nothing deletes one, [domain.md](../domain.md)).

`create` in `apps/api/src/modules/work-types/work-types.service.ts` counted the cap `QUOTA_WORK_TYPES_PER_TEAM` (GWP#50) with `tx.workType.count({ where: { teamId } })`, archived rows included. A team that reached its cap could archive work types but never free a place, so it could not add a work type again. Unarchive, a bare `updateMany` with no transaction or lock, did not look at the cap.

Fix (owner's decision A, 2026-11-03): only active (`archivedAt: null`) work types count. `create` counts active ones under the team's row lock. Unarchive, whenever the cap applies, runs in a transaction under the same lock, in this order: 404 if the work type is not in the team; 200 unchanged if it is already active; 409 with create's message (`This team has reached its limit of ${cap} work types`) if the team's active work types are at the cap, writing nothing; otherwise it clears `archivedAt`. A team can hold more rows than the cap in total, but never more active work types than the cap.

Regression tests: `apps/api/test/quotas.integration.test.ts` "archived work types do not count against the cap (GWP#103)": "at the cap, archiving one work type lets a create succeed", "at the cap with one archived, unarchiving it answers 409 with the cap message and it stays archived", "at the cap, unarchiving an already-active work type answers 200 and changes nothing", "unarchiving an unknown id answers 404" and "with one place left and two archived, two unarchives at once leave exactly one 200 and one 409".

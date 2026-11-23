# A work type version could be deleted, and stored definitions were re-parsed on read

Resolved before merge, GWP#2. Found by the fresh-context whole-branch review.

## Version delete

`WorkTypeVersion` is immutable (docs/domain.md), but the trigger in `packages/db/prisma/migrations/20261021120000_domain/migration.sql` fired on `UPDATE` only. A version no item referenced could be deleted, so a work type could lose part of its history; the foreign key from `Item` protected only versions in use.

Fix: the trigger fires `BEFORE UPDATE OR DELETE` and raises `WorkTypeVersion is immutable`.

Regression test: `packages/db/test/triggers.integration.test.ts`, "a DELETE on WorkTypeVersion raises the immutable error, even for a version no item uses".

## Definition re-parsed on read

`toWorkTypeResponse` (`apps/api/src/modules/work-types/work-types.service.ts`) ran `WorkTypeDefinition.parse` on every stored definition. Definitions are validated when written and never change, so a later, stricter contract would have turned old versions into 500s on every read of their work type.

Fix: the stored definition is returned as written.

Regression test: `apps/api/test/domain-services.test.ts`, "a stored definition is returned as written, not re-validated, so a later, stricter contract cannot break old rows".

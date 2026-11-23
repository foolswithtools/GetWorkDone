-- The waiting-for-me queue, work type archive and stuck-item sweeper (GWP#55, docs/process.md). The
-- schema changes are generated from prisma/schema.prisma (`prisma migrate diff --from-config-datasource
-- --to-schema prisma/schema.prisma --script` against the database with the earlier migrations applied);
-- the backfill is written by hand.
--
-- Item.waitingRole is the assigneeRole of the human step an item is waiting at, so the queue
-- (`?waiting=me`) is a WHERE beside the (createdAt, id) cursor. WorkType.archivedAt retires a work type.
-- Item(status, updatedAt) serves the sweeper's scan of `open` and `in_progress` items, oldest first.

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "waitingRole" "TeamRole";

-- AlterTable
ALTER TABLE "WorkType" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Item_teamId_waitingRole_createdAt_id_idx" ON "Item"("teamId", "waitingRole", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Item_status_updatedAt_idx" ON "Item"("status", "updatedAt");

-- Backfill: an item already waiting is `in_progress`, its current step in its version's definition is a
-- human step, and its last event, a `data_edited` aside (it moves no step, as the engine reads it), is
-- that step's `step_started`. It takes the step's assigneeRole. Idempotent; updatedAt is left as it was.
-- apps/api/test/queue.integration.test.ts runs the statement between the markers.
-- backfill:begin
UPDATE "Item" AS i
SET "waitingRole" = (v."definition" -> 'steps' -> i."currentStepIndex" ->> 'assigneeRole')::"TeamRole"
FROM "WorkTypeVersion" AS v
WHERE v."id" = i."workTypeVersionId"
  AND i."status" = 'in_progress'
  AND i."waitingRole" IS NULL
  AND v."definition" -> 'steps' -> i."currentStepIndex" ->> 'kind' = 'human'
  AND (
    SELECT e."type" FROM "ItemEvent" AS e
    WHERE e."itemId" = i."id" AND e."type" <> 'data_edited'
    ORDER BY e."seq" DESC
    LIMIT 1
  ) = 'step_started';
-- backfill:end

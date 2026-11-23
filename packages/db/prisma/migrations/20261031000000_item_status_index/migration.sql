-- The items list filtered by status (GWP#54, docs/capture.md): `?status=` is a WHERE beside the
-- (createdAt, id) cursor, so one index serves a status's page in order. It leads with teamId, so it
-- replaces Item(teamId). Generated from prisma/schema.prisma (`prisma migrate diff
-- --from-config-datasource --to-schema prisma/schema.prisma --script` against the database with the
-- earlier migrations applied).
-- DropIndex
DROP INDEX "Item_teamId_idx";

-- CreateIndex
CREATE INDEX "Item_teamId_status_createdAt_id_idx" ON "Item"("teamId", "status", "createdAt", "id");

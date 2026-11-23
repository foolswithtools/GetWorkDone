-- The stuck-item sweeper's partial index (GWP#157, docs/process.md "Resume"), the expand step of
-- docs/deploy/sandbox.md "Expand, then contract". The schema change is generated from prisma/schema.prisma
-- (`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` against the
-- database with the earlier migrations applied), then built CONCURRENTLY so writes to Item go on meanwhile.
--
-- The sweep lists items with "waitingRole" IS NULL; Item_status_updatedAt_idx walks every old item parked at a
-- human step and discards it, this one holds none of them. Item_status_updatedAt_idx stays for the image still
-- serving during the rollout; the contract follow-up drops it.
--
-- This file must stay one statement: `prisma migrate deploy` sends a file as one query string, which Postgres
-- runs as one implicit transaction, and CONCURRENTLY refuses to run in a transaction (so no DROP INDEX
-- CONCURRENTLY IF EXISTS before it). A build that fails leaves the index INVALID and this migration failed;
-- docs/deploy/sandbox.md "Expand, then contract" gives the recovery: drop the index, mark the migration
-- rolled back, migrate again.

-- CreateIndex
CREATE INDEX CONCURRENTLY "Item_status_updatedAt_waiting_null_idx" ON "Item"("status", "updatedAt") WHERE ("waitingRole" IS NULL);

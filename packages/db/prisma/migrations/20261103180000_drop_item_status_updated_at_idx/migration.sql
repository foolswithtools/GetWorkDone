-- The contract step of docs/deploy/sandbox.md "Expand, then contract" (GWP#158): drops the stuck-item
-- sweeper's unfiltered index from 20261031120000_waiting_role_and_archive, which no query has used since
-- 20261103120000_item_sweep_index (GWP#157) built Item_status_updatedAt_waiting_null_idx and that release
-- reached prod. The schema change is generated from prisma/schema.prisma (`prisma migrate diff
-- --from-config-datasource --to-schema prisma/schema.prisma --script` against the database with the earlier
-- migrations applied), then dropped CONCURRENTLY so writes to Item go on meanwhile, and IF EXISTS so a re-run
-- after a failed drop, or a database that never had the index, passes.
--
-- This file must stay one statement: `prisma migrate deploy` sends a file as one query string, which Postgres
-- runs as one implicit transaction, and CONCURRENTLY refuses to run in a transaction (25001). A drop that
-- fails leaves this migration failed; docs/deploy/sandbox.md "Expand, then contract" gives the recovery.

-- DropIndex
DROP INDEX CONCURRENTLY IF EXISTS "Item_status_updatedAt_idx";

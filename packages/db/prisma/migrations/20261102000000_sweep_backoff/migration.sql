-- The stuck-item sweeper's backoff (GWP#102, docs/process.md "Resume"). The schema change is generated
-- from prisma/schema.prisma (`prisma migrate diff --from-config-datasource --to-schema
-- prisma/schema.prisma --script` against the database with the earlier migrations applied).
--
-- Item.sweepRetryAt is when the sweeper may try again an item whose advance it could not make, and
-- Item.sweepFailures how many times in a row it could not; every transition clears both. No backfill:
-- every existing item starts with no backoff (null, 0), as the sweeper had none before.

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "sweepFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sweepRetryAt" TIMESTAMP(3);


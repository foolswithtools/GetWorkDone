-- Quotas (GWP#50, docs/domain.md): one row per quota key with its count in the window of windowMs from
-- windowStart, shared by every API task. Generated from prisma/schema.prisma (`prisma migrate diff
-- --from-config-datasource --to-schema prisma/schema.prisma --script` against the database with the
-- earlier migrations applied). The session purge deletes windows whose windowStart + windowMs has passed.
-- CreateTable
CREATE TABLE "QuotaWindow" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowMs" INTEGER NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "QuotaWindow_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "QuotaWindow_windowStart_idx" ON "QuotaWindow"("windowStart");


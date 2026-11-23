-- Sign-in rate limit (GWP#32, docs/auth.md): one row per client key with its GET /auth/login count in
-- the minute from windowStart, shared by every API task. Generated from prisma/schema.prisma
-- (`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` against the
-- database with the earlier migrations applied). The session purge deletes ended windows.
-- CreateTable
CREATE TABLE "LoginRateWindow" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "LoginRateWindow_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "LoginRateWindow_windowStart_idx" ON "LoginRateWindow"("windowStart");


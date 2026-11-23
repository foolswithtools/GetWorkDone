-- Distribution (GWP#6, docs/outputs.md): one Delivery row per completed item and email or webhook output,
-- each webhook output's signing secret, and on-request exports. Item gains a unique (id, teamId) so a
-- delivery's team must match its item's, as for every other child table.

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('pending', 'delivered', 'failed');

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "outputId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutputSecret" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "workTypeId" TEXT NOT NULL,
    "outputId" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutputSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Export" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "workTypeId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "createdBySubject" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Export_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_idempotencyKey_key" ON "Delivery"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Delivery_status_nextAttemptAt_idx" ON "Delivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "Delivery_itemId_idx" ON "Delivery"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "OutputSecret_workTypeId_outputId_key" ON "OutputSecret"("workTypeId", "outputId");

-- CreateIndex
CREATE INDEX "Export_teamId_workTypeId_idx" ON "Export"("teamId", "workTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "Item_id_teamId_key" ON "Item"("id", "teamId");

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_itemId_teamId_fkey" FOREIGN KEY ("itemId", "teamId") REFERENCES "Item"("id", "teamId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutputSecret" ADD CONSTRAINT "OutputSecret_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutputSecret" ADD CONSTRAINT "OutputSecret_workTypeId_teamId_fkey" FOREIGN KEY ("workTypeId", "teamId") REFERENCES "WorkType"("id", "teamId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Export" ADD CONSTRAINT "Export_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Export" ADD CONSTRAINT "Export_workTypeId_teamId_fkey" FOREIGN KEY ("workTypeId", "teamId") REFERENCES "WorkType"("id", "teamId") ON DELETE RESTRICT ON UPDATE CASCADE;


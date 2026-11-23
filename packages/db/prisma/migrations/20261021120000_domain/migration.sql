-- The domain model (GWP#2, spec §4.3; docs/domain.md). The tables, indexes and foreign keys are
-- generated from prisma/schema.prisma (`prisma migrate diff --from-empty --to-schema
-- prisma/schema.prisma --script`); the triggers at the end are hand-written, because Prisma cannot
-- express them. test/migrate.integration.test.ts checks the tables still match the schema.

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('member', 'admin');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('open', 'in_progress', 'completed', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "role" "TeamRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkType" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkTypeVersion" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "workTypeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkTypeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "workTypeVersionId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "status" "ItemStatus" NOT NULL DEFAULT 'open',
    "currentStepIndex" INTEGER NOT NULL DEFAULT 0,
    "rowVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemEvent" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "actorSubject" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,

    CONSTRAINT "ItemEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeamMember_subject_idx" ON "TeamMember"("subject");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_teamId_subject_key" ON "TeamMember"("teamId", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "WorkType_teamId_slug_key" ON "WorkType"("teamId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "WorkType_id_teamId_key" ON "WorkType"("id", "teamId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkTypeVersion_workTypeId_version_key" ON "WorkTypeVersion"("workTypeId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "WorkTypeVersion_id_teamId_key" ON "WorkTypeVersion"("id", "teamId");

-- CreateIndex
CREATE INDEX "Item_teamId_idx" ON "Item"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemEvent_itemId_seq_key" ON "ItemEvent"("itemId", "seq");

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkType" ADD CONSTRAINT "WorkType_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkTypeVersion" ADD CONSTRAINT "WorkTypeVersion_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkTypeVersion" ADD CONSTRAINT "WorkTypeVersion_workTypeId_teamId_fkey" FOREIGN KEY ("workTypeId", "teamId") REFERENCES "WorkType"("id", "teamId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_workTypeVersionId_teamId_fkey" FOREIGN KEY ("workTypeVersionId", "teamId") REFERENCES "WorkTypeVersion"("id", "teamId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemEvent" ADD CONSTRAINT "ItemEvent_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ItemEvent is the append-only audit trail: no row is ever updated or deleted, and the table is
-- never truncated. Clearing Item.data for the `none` output (D-048) leaves every event in place.
CREATE FUNCTION "item_event_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ItemEvent is append-only: % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER "ItemEvent_append_only"
    BEFORE UPDATE OR DELETE ON "ItemEvent"
    FOR EACH ROW EXECUTE FUNCTION "item_event_append_only"();

CREATE TRIGGER "ItemEvent_no_truncate"
    BEFORE TRUNCATE ON "ItemEvent"
    FOR EACH STATEMENT EXECUTE FUNCTION "item_event_append_only"();

-- A work type version never changes or goes away once written: a change to a work type is the next
-- version row, so every item keeps the definition it was captured under.
CREATE FUNCTION "work_type_version_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'WorkTypeVersion is immutable: % is not allowed, write the next version instead', TG_OP;
END;
$$;

CREATE TRIGGER "WorkTypeVersion_immutable"
    BEFORE UPDATE OR DELETE ON "WorkTypeVersion"
    FOR EACH ROW EXECUTE FUNCTION "work_type_version_immutable"();

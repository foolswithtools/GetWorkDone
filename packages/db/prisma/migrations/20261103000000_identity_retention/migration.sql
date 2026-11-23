-- The Identity retention rule (GWP#143, docs/auth.md "Team membership"). The schema change is generated from
-- prisma/schema.prisma (`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma
-- --script` against the database with the earlier migrations applied).
--
-- The session purge deletes an Identity 90 days after its last sign-in (updatedAt) once its subject is in no
-- team and has no unexpired session; this index lets it find the old rows without scanning the table.

-- CreateIndex
CREATE INDEX "Identity_updatedAt_idx" ON "Identity"("updatedAt");

-- Members by name (GWP#99, docs/auth.md "Team membership"). The schema change is generated from
-- prisma/schema.prisma (`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma
-- --script` against the database with the earlier migrations applied).
--
-- Identity is a person's email and display name as their identity provider last asserted them, keyed by
-- subject and upserted on every sign-in. No backfill: existing members show no profile until they next
-- sign in. No foreign key to TeamMember, which may name a subject that has never signed in.

-- CreateTable
CREATE TABLE "Identity" (
    "subject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Identity_pkey" PRIMARY KEY ("subject")
);

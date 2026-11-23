-- The API's database role (#57): table DML in schema public and nothing else. No CREATE, no TRUNCATE,
-- no ownership, so a bug or an injection in the API cannot drop a table, disable the append-only
-- triggers (docs/domain.md) or read pg_authid. Nor what every role inherits from PUBLIC (#121):
-- no TEMPORARY on the database and no EXECUTE on the functions in schema public. The API calls
-- none of them; the migrations' two are trigger functions, which fire without EXECUTE.
-- The migrate task runs this after `prisma migrate deploy`, as the user that ran the migrations
-- (RDS's master user in the sandbox), so the tables it owns now and the ones later migrations create
-- are covered (packages/db/src/migrate-task.ts).
--
-- Idempotent: a second run creates nothing and sets the password again, so an owner who puts a new
-- password in getworkdone/<instance>/db-app has it take effect on the next migrate run.
--
-- The password is psql's quoted variable `password`, written once, below, outside every dollar quote
-- (psql does not substitute inside one): `psql -v password=... -f app-role.sql` runs this file as it is.
-- renderAppRoleSql (packages/db/src/app-role.ts) replaces it with the password's SCRAM-SHA-256 verifier
-- before the migrate task hands the script to `prisma db execute --stdin`, so the plaintext never reaches
-- the server, its logs or an error's CONTEXT; Postgres stores a verifier given as a password as it is.
-- The value reaches the DO block through a session setting, never through the dollar-quoted text.
SET standard_conforming_strings = on;
SELECT set_config('getworkdone.app_role_password', :'password', false);

DO $app_role$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'getworkdone_app') THEN
    -- NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION and NOBYPASSRLS are CREATE ROLE's defaults.
    CREATE ROLE getworkdone_app LOGIN;
  END IF;
  EXECUTE format('ALTER ROLE getworkdone_app WITH LOGIN PASSWORD %L', current_setting('getworkdone.app_role_password'));
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO getworkdone_app', current_database());
  -- PUBLIC's by default (#121); the master user keeps TEMPORARY as the database's owner.
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END
$app_role$;

SELECT set_config('getworkdone.app_role_password', '', false);

GRANT USAGE ON SCHEMA public TO getworkdone_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO getworkdone_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO getworkdone_app;

-- PUBLIC's by default too (#121); the master user keeps EXECUTE as the functions' owner.
REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA public FROM PUBLIC;

-- Prisma's own bookkeeping is the migrations', not the API's.
DO $app_role$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE public._prisma_migrations FROM getworkdone_app;
  END IF;
END
$app_role$;

-- With no FOR ROLE these apply to objects the current user creates: the user migrations run as.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO getworkdone_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO getworkdone_app;
-- Without IN SCHEMA: a per-schema default only adds to the global ones, so it cannot take away the
-- built-in EXECUTE to PUBLIC. This covers every schema the migration user creates functions in.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

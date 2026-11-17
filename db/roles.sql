-- AutoCare Türkiye — login roles. Run with psql (>= 15) while connected to database `autocare`
-- as a superuser, AFTER db/schema.sql. Idempotent: safe to run again.
--
-- Passwords are NOT in this file. psql reads them from the environment at run time:
--   AUTOCARE_APP_PASSWORD  -> role autocare_app  (the web app: DML on the application tables)
--   SQLBUDDY_RO_PASSWORD   -> role sqlbuddy_ro   (SQLBuddy Appliance: read-only)
-- seed/load.sh passes them from .env into the psql process.

\set ON_ERROR_STOP on
\getenv app_pw AUTOCARE_APP_PASSWORD
\getenv ro_pw SQLBUDDY_RO_PASSWORD
\if :{?app_pw}
\else
  DO $$ BEGIN RAISE EXCEPTION 'AUTOCARE_APP_PASSWORD is not set in the environment'; END $$;
\endif
\if :{?ro_pw}
\else
  DO $$ BEGIN RAISE EXCEPTION 'SQLBUDDY_RO_PASSWORD is not set in the environment'; END $$;
\endif

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'autocare_app') THEN
        CREATE ROLE autocare_app LOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sqlbuddy_ro') THEN
        CREATE ROLE sqlbuddy_ro LOGIN;
    END IF;
END
$$;

ALTER ROLE autocare_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;
ALTER ROLE sqlbuddy_ro  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

-- psql substitutes :'var' as a quoted literal; the value is not echoed.
ALTER ROLE autocare_app PASSWORD :'app_pw';
ALTER ROLE sqlbuddy_ro  PASSWORD :'ro_pw';
\unset app_pw
\unset ro_pw

-- Extra guard for the read-only login (a session default, not a privilege).
ALTER ROLE sqlbuddy_ro SET default_transaction_read_only = on;

-- Database: nobody gets anything by default (removes PUBLIC's CONNECT and TEMPORARY).
REVOKE ALL ON DATABASE autocare FROM PUBLIC;
GRANT CONNECT ON DATABASE autocare TO autocare_app, sqlbuddy_ro;

-- Schema: use only, never create.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO autocare_app, sqlbuddy_ro;

-- autocare_app: DML on all application tables, sequences for identity inserts.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO autocare_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO autocare_app;

-- sqlbuddy_ro: SELECT on all tables, nothing else.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sqlbuddy_ro;

-- Same rights on tables created later by the owner (the role running this script).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO autocare_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO autocare_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO sqlbuddy_ro;

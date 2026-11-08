-- VEYRA database roles: LOCAL DEVELOPMENT AND TESTS ONLY.
-- Run once as a PostgreSQL superuser, connected to the "postgres" database. Each statement runs
-- on its own (CREATE DATABASE cannot run inside a transaction).
--
--   veyra_owner  owns the database and schema; runs migrations. Not a superuser.
--                CREATEDB is granted here only so `prisma migrate dev` can create its shadow
--                database; production owners do not get it.
--   veyra_app    the API and worker connect as this role. NOSUPERUSER and NOBYPASSRLS, so
--                row-level security always applies. Gets table privileges from the migrations.
--
-- The passwords below are development placeholders. Production roles and passwords are created
-- by the deployment from a secrets manager (docs/engineering/DEVELOPMENT_SETUP.md).

CREATE ROLE veyra_owner LOGIN PASSWORD 'veyra_owner_dev' NOSUPERUSER CREATEDB NOCREATEROLE NOBYPASSRLS;

CREATE ROLE veyra_app LOGIN PASSWORD 'veyra_app_dev' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

CREATE DATABASE veyra OWNER veyra_owner;

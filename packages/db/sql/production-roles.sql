-- VEYRA database roles for PRODUCTION (Phase 14 Part 4). Compare bootstrap-roles.sql, which is
-- for local development only.
--
-- Run once per environment by an operator, as an administrator of the managed PostgreSQL
-- service, with the passwords taken from the secrets manager (never typed into a shell history):
--
--   psql "$ADMIN_URL" -v ON_ERROR_STOP=1 \
--        -v owner_password="$VEYRA_OWNER_PASSWORD" -v app_password="$VEYRA_APP_PASSWORD" \
--        -f packages/db/sql/production-roles.sql
--
--   veyra_owner  owns the database and schema and runs migrations (prisma migrate deploy) from
--                the deployment pipeline only. No CREATEDB, CREATEROLE or BYPASSRLS.
--   veyra_app    the API and the worker connect as this role. Row-level security always
--                applies; table privileges come from the migrations.
--
-- Platform administrators are granted with packages/db/scripts/platform-admin.ts, as the owner.

\if :{?owner_password}
\else
  \echo 'Set -v owner_password=... from the secrets manager'
  \quit
\endif
\if :{?app_password}
\else
  \echo 'Set -v app_password=... from the secrets manager'
  \quit
\endif

CREATE ROLE veyra_owner LOGIN PASSWORD :'owner_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
CREATE ROLE veyra_app LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION
  CONNECTION LIMIT 200;

CREATE DATABASE veyra OWNER veyra_owner;

\connect veyra

-- Nobody but the owner creates objects; the application only uses what migrations grant.
REVOKE ALL ON DATABASE veyra FROM PUBLIC;
GRANT CONNECT ON DATABASE veyra TO veyra_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO veyra_owner;
GRANT USAGE ON SCHEMA public TO veyra_app;

-- Guard rails for the application role: a stuck query or transaction cannot hold locks forever.
ALTER ROLE veyra_app SET statement_timeout = '30s';
ALTER ROLE veyra_app SET idle_in_transaction_session_timeout = '60s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "OrganisationStatus" AS ENUM ('PENDING_ONBOARDING', 'ACTIVE', 'SUSPENDED', 'OFFBOARDING', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('ORGANISATION', 'PROPERTY', 'BUILDING', 'UNIT');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "email_verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_credentials" (
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "password_credentials_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "ip_address" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "default_currency" CHAR(3) NOT NULL,
    "default_time_zone" TEXT NOT NULL,
    "status" "OrganisationStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "scope_type" "ScopeType" NOT NULL DEFAULT 'ORGANISATION',
    "scope_id" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "valid_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMPTZ(3),
    "granted_by_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "scope_type" "ScopeType" NOT NULL DEFAULT 'ORGANISATION',
    "scope_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "accepted_by_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "invited_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organisation_id" UUID,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "request_id" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "organisation_id" UUID,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organisations_slug_key" ON "organisations"("slug");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE INDEX "memberships_organisation_id_scope_type_scope_id_idx" ON "memberships"("organisation_id", "scope_type", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_organisation_id_user_id_role_scope_type_scope_i_key" ON "memberships"("organisation_id", "user_id", "role", "scope_type", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_organisation_id_idx" ON "invitations"("organisation_id");

-- CreateIndex
CREATE INDEX "audit_logs_organisation_id_created_at_idx" ON "audit_logs"("organisation_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_available_at_idx" ON "outbox_events"("published_at", "available_at");

-- AddForeignKey
ALTER TABLE "password_credentials" ADD CONSTRAINT "password_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================================
-- Hand-written below this line: constraints, row-level security, grants, immutability.
-- See docs/architecture/MULTI_TENANCY.md. Requires the role "veyra_app" to exist
-- (created by packages/db/sql/bootstrap-roles.sql or the deployment's role setup).
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Data integrity
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "users" ADD CONSTRAINT "users_email_normalised"
  CHECK ("email" = lower(btrim("email")) AND position('@' IN "email") > 1);
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_email_normalised"
  CHECK ("email" = lower(btrim("email")) AND position('@' IN "email") > 1);
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_slug_format"
  CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("slug") BETWEEN 3 AND 63);
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_country_code_format"
  CHECK ("country_code" ~ '^[A-Z]{2}$');
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_default_currency_format"
  CHECK ("default_currency" ~ '^[A-Z]{3}$');
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_validity_window"
  CHECK ("valid_until" IS NULL OR "valid_until" > "valid_from");
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_scope_matches"
  CHECK ("scope_type" <> 'ORGANISATION' OR "scope_id" = "organisation_id");
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_revocation_consistent"
  CHECK (("status" = 'REVOKED') = ("revoked_at" IS NOT NULL));
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_org_scope_matches"
  CHECK ("scope_type" <> 'ORGANISATION' OR "scope_id" = "organisation_id");
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_expiry_order"
  CHECK ("idle_expires_at" <= "absolute_expires_at");

-- ---------------------------------------------------------------------------------------------
-- Request context. The application sets these per transaction with set_config(..., true).
-- NULLIF handles the empty string Postgres returns after a transaction-local setting resets.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION app_current_organisation_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.organisation_id', true), '')::uuid $$;

CREATE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- ---------------------------------------------------------------------------------------------
-- Row-level security. FORCE applies policies to the table owner too (superusers still bypass,
-- so the application must never connect as a superuser). No policy for an operation = denied.
-- ---------------------------------------------------------------------------------------------

-- organisations: visible in its own tenant context, or to a user with an active membership in it.
ALTER TABLE "organisations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organisations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organisations_select" ON "organisations" FOR SELECT
  USING (
    "id" = app_current_organisation_id()
    OR EXISTS (
      SELECT 1 FROM "memberships" m
      WHERE m."organisation_id" = "organisations"."id"
        AND m."user_id" = app_current_user_id()
        AND m."status" = 'ACTIVE'
    )
  );
CREATE POLICY "organisations_insert" ON "organisations" FOR INSERT
  WITH CHECK ("id" = app_current_organisation_id());
CREATE POLICY "organisations_update" ON "organisations" FOR UPDATE
  USING ("id" = app_current_organisation_id())
  WITH CHECK ("id" = app_current_organisation_id());

-- memberships: tenant context sees the tenant's memberships; a user always sees their own
-- (needed to list "my organisations"). Writes only inside the owning tenant context.
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY "memberships_select" ON "memberships" FOR SELECT
  USING ("organisation_id" = app_current_organisation_id() OR "user_id" = app_current_user_id());
CREATE POLICY "memberships_insert" ON "memberships" FOR INSERT
  WITH CHECK ("organisation_id" = app_current_organisation_id());
CREATE POLICY "memberships_update" ON "memberships" FOR UPDATE
  USING ("organisation_id" = app_current_organisation_id())
  WITH CHECK ("organisation_id" = app_current_organisation_id());

-- invitations: tenant context only. Token-based acceptance (no tenant context yet) gets a
-- dedicated SECURITY DEFINER lookup in the invitations migration (Phase 2, Part 5).
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "invitations_select" ON "invitations" FOR SELECT
  USING ("organisation_id" = app_current_organisation_id());
CREATE POLICY "invitations_insert" ON "invitations" FOR INSERT
  WITH CHECK ("organisation_id" = app_current_organisation_id());
CREATE POLICY "invitations_update" ON "invitations" FOR UPDATE
  USING ("organisation_id" = app_current_organisation_id())
  WITH CHECK ("organisation_id" = app_current_organisation_id());

-- audit_logs: readable within the tenant; platform events (null organisation) are writable
-- without tenant context but readable only through privileged platform tooling.
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "audit_logs_select" ON "audit_logs" FOR SELECT
  USING ("organisation_id" = app_current_organisation_id());
CREATE POLICY "audit_logs_insert" ON "audit_logs" FOR INSERT
  WITH CHECK ("organisation_id" IS NULL OR "organisation_id" = app_current_organisation_id());

-- ---------------------------------------------------------------------------------------------
-- Audit log immutability: rejected for every role, including the owner.
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION reject_audit_log_modification() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'insufficient_privilege'; END $$;

CREATE TRIGGER "audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_modification();

CREATE TRIGGER "audit_logs_no_truncate"
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_log_modification();

-- ---------------------------------------------------------------------------------------------
-- Least-privilege grants for the application role (no DDL, no TRUNCATE, no BYPASSRLS).
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO veyra_app;
GRANT SELECT, INSERT, UPDATE ON "users", "organisations", "memberships", "invitations" TO veyra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "password_credentials", "sessions" TO veyra_app;
GRANT SELECT, INSERT ON "audit_logs" TO veyra_app;
GRANT SELECT, INSERT, UPDATE ON "outbox_events" TO veyra_app;
GRANT EXECUTE ON FUNCTION app_current_organisation_id(), app_current_user_id() TO veyra_app;


-- Invitation acceptance (Phase 2, Part 5).
--
-- The invitee has no tenant context yet, so the tenant-only SELECT policy hides the invitation.
-- Instead of a SECURITY DEFINER function (which would run as the schema owner, itself subject to
-- FORCE ROW LEVEL SECURITY), the policy also admits a row whose token hash the caller presents
-- through a transaction-local setting. Knowing the hash requires the 256-bit token, so this
-- exposes exactly one invitation to exactly its holder.

CREATE FUNCTION app_current_invitation_token_hash() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.invitation_token_hash', true), '') $$;

GRANT EXECUTE ON FUNCTION app_current_invitation_token_hash() TO veyra_app;

DROP POLICY "invitations_select" ON "invitations";
CREATE POLICY "invitations_select" ON "invitations" FOR SELECT
  USING (
    "organisation_id" = app_current_organisation_id()
    OR "token_hash" = app_current_invitation_token_hash()
  );

-- At most one pending invitation per organisation, email and role. Accepted or revoked
-- invitations do not count. (Expiry is time-based and cannot be part of an index predicate; the
-- application revokes an expired pending invitation before issuing a new one.)
CREATE UNIQUE INDEX "invitations_one_pending_per_role"
  ON "invitations" ("organisation_id", "email", "role")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

-- Accepting and revoking are mutually exclusive.
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_single_outcome"
  CHECK ("accepted_at" IS NULL OR "revoked_at" IS NULL);
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_acceptance_consistent"
  CHECK (("accepted_at" IS NULL) = ("accepted_by_id" IS NULL));

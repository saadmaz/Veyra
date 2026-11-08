-- Phase 3 Part 2: invitations can target a property, so "one pending invitation" is per scope.
-- The same person may be invited as property manager of P1 and of P2 at the same time.
-- Safe on existing data: the new index is strictly less restrictive than the old one.

DROP INDEX "invitations_one_pending_per_role";

CREATE UNIQUE INDEX "invitations_one_pending_per_scope"
  ON "invitations" ("organisation_id", "email", "role", "scope_type", "scope_id")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

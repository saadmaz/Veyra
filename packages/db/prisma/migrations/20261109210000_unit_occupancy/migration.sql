-- Phase 4 Part 3: a unit is "occupied" while it has a non-voided ownership, tenancy or household
-- record that has not ended before today in the property's time zone (current or future).
-- Structure archiving (properties module) refuses occupied units, buildings, floors and
-- properties through this one rule, without importing the residents module.
-- Runs as the caller under RLS (tenant context).

CREATE FUNCTION app_unit_is_occupied(p_unit uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
  WITH local_today AS (
    SELECT (now() AT TIME ZONE p."time_zone")::date AS d
      FROM "units" u JOIN "properties" p ON p."id" = u."property_id"
     WHERE u."id" = p_unit
  )
  SELECT EXISTS (
    SELECT 1 FROM "ownerships" o, local_today t
     WHERE o."unit_id" = p_unit AND o."voided_at" IS NULL
       AND (o."effective_to" IS NULL OR o."effective_to" >= t."d")
  ) OR EXISTS (
    SELECT 1 FROM "tenancies" tn, local_today t
     WHERE tn."unit_id" = p_unit AND tn."voided_at" IS NULL
       AND (tn."end_date" IS NULL OR tn."end_date" >= t."d")
  ) OR EXISTS (
    SELECT 1 FROM "household_members" h, local_today t
     WHERE h."unit_id" = p_unit AND h."voided_at" IS NULL
       AND (h."valid_to" IS NULL OR h."valid_to" >= t."d")
  )
$$;

GRANT EXECUTE ON FUNCTION app_unit_is_occupied(uuid) TO veyra_app;

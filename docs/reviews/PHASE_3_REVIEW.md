# Phase 3 exit review: Organisation and property management

- **Date:** 2026-11-09
- **Scope:** PRs #12 (data foundation), #13 (property-scoped access), #14 (structure API),
  #15 (property console)
- **Decision:** Phase 3 is complete. Proceed to Phase 4 (residents and units). The Stage 1 exit
  gate is now met for properties as well as organisations. The pilot-readiness items from the
  Phase 2 review are still open (section 5).

## 1. Exit gate

Stage 1 exit gate (ROADMAP): *automated tests prove one organisation/property cannot access
another's protected data*.

| Part of the gate | Status | Evidence |
| ---------------- | ------ | -------- |
| Organisation isolation | ✅ (Phase 2) | `rls.int.test.ts`, `organisations.int.test.ts` |
| Property structure cannot reference another tenant or property | ✅ | `property-structure.int.test.ts`: composite tenant foreign keys reject a building on another tenant's property, a floor or unit on another property's building, a unit on another building's floor |
| A property-scoped user cannot reach another property of the same organisation | ✅ | `properties.int.test.ts`: a property manager of P1 gets 404 on P2 by every path, sees only P1 in lists; `structure.int.test.ts`: the manager of another property and outsiders get 404 on the structure |
| Scope never reaches upward | ✅ | Unit tests (`policy.test.ts`); a property manager holds only the baseline organisation permission (API test) |

## 2. Product requirements (PRD 3.1)

| Requirement | Status |
| ----------- | ------ |
| Multiple properties per organisation | ✅ |
| Property, building, floor, unit and common-area inventory | ✅ |
| Parking inventory | ⏳ Not modelled (with vehicles, Phase 4, or Phase 9) |
| Property currency, IANA time zone, address | ✅ (country and currency fixed once active) |
| Property locale, operational rules, branding | ⏳ Not started |
| Property lifecycle states | ✅ ONBOARDING, ACTIVE, ARCHIVED (archive cascades to the structure) |
| History of material configuration changes | ✅ Audit record for every property and structure change (field names, not values) |

## 3. Verification at the time of review

| Suite | Result |
| ----- | ------ |
| Lint, typecheck (18 workspaces), build (12) | ✅ |
| Unit tests | ✅ 198 (API 126, console 21, domain 20, db 9, worker 6, other packages 16) |
| Integration, real PostgreSQL 17 | ✅ db 60, API 70; plus 5 Redis tests that run in CI |
| Browser journeys (Playwright, desktop and phone, axe WCAG 2.2 AA) | ✅ 32 |
| CI `verify` on every PR | ✅ #12-#15 green before merge |

Defects found and fixed during the phase: anti-escalation compared only organisation-level
permissions (would have blocked inviting a finance officer); a stale floor list on the building
page; an ambiguous "Code" label; sign-in forms that could have submitted credentials in the URL
before scripts loaded (now `method="post"`).

## 4. Design review

| Area | Assessment |
| ---- | ---------- |
| Tenant and property isolation | Database: RLS on every structure table, composite tenant foreign keys, archive-only (no DELETE grant), scope trigger for memberships and invitations. API: property permissions evaluated at the route's property, 404 for uncovered properties, server-side list filtering |
| Concurrency | Create and archive serialised by row locks (share on the parent, update on the archived row). The race test checks outcomes over 5 rounds but cannot force every interleaving; the locks are the guarantee |
| Data integrity | Case-insensitive unit numbers per building and per property; positive decimals stored as DECIMAL and exchanged as strings; floor requires building (closes a `MATCH SIMPLE` gap) |
| Module boundaries | access-control, organisations and properties import each other only through `index.ts` |

## 5. Open items

### Still required before a pilot stores real data (from the Phase 2 review, unchanged)

MFA, email verification and password reset; structured JSON logging with redaction; secret
scanning in CI; console Content-Security-Policy; production database roles and tested backups;
a full-stack smoke test (console + API + PostgreSQL + Redis).

### New in Phase 3, can wait

- Console: editing forms for property settings and for individual buildings, floors, units and
  common areas (the API supports updates); unit lists beyond 200 rows.
- Restoring archived properties or structure; moving units between buildings.
- Property managers inviting others to their own property.
- Building- and unit-scoped roles.
- Parking inventory, property locale, branding and operational rules.

### Must be added in Phase 4

- Archiving a unit (or anything containing units) must be refused while the unit has an active
  ownership or tenancy.
- Owner and tenant access derived from ownership and tenancy records (ACCESS_CONTROL section 1).

## 6. Documentation

Up to date: ACCESS_CONTROL (sections 6.1-6.5), MULTI_TENANCY (composite keys, scope trigger),
DATA_MODEL section 3, API_DESIGN (properties and structure), TESTING_STRATEGY (Phase 3), ROADMAP,
CHANGELOG, console README.

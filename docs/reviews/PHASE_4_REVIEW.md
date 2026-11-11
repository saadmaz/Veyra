# Phase 4 exit review: Resident and unit management

- **Date:** 2026-11-11
- **Scope:** PRs #17 (resident data foundation), #18 (derived resident access and invitations),
  #19 (staff residents API, occupancy guard), and Part 4 (resident console, this change). Part 4
  also brings over the person-picker endpoint and the resident view from the unmerged branch
  `feat/phase-4-resident-console` (2026-11-09), which built the same part independently
- **Decision:** Phase 4 is complete for staff workflows, with a first resident view in the
  console ("Your homes", "Who lives here"). Proceed to Phase 5 (visitor and access
  management) once the owner has reviewed this document. The resident mobile app was deferred
  by decision (2026-11-09) and is not part of this exit. The pilot-readiness items from the
  Phase 2 review are still open (section 5).

## 1. Exit criteria

| Criterion | Status | Evidence |
| --------- | ------ | -------- |
| Ownership and tenancy periods with effective dates, never silently rewritten | ✅ | Database: inclusive date periods, exclusion constraints, voiding instead of deleting (`residents` migration, 22 db tests). API: transfers end current owners the day before; backdated changes refused (`OWNERSHIP_CONFLICT`) |
| Ownership shares exact, adding up to one at every date | ✅ | Deferred database check, BigInt validation in the API and in the console (no floating point); voiding one co-owner refused at commit (API integration test) |
| Owner, tenant and household access derived from records, never assigned | ✅ | `app_resident_grants`, computed for today in the property's time zone; API tests run in a time zone whose date differs from UTC |
| Staff manage residents only where they are scoped | ✅ | API: another property's manager and outsiders get 404 (Part 3 integration tests). Console: a property manager gets "Unit not found" for another property's unit (browser test) |
| Data minimisation for roles that do not need resident data | ✅ | Finance officers have no resident permissions (API tests). Console: shows unit details only and never requests resident endpoints (asserted on the request log) |
| Units cannot be archived while occupied | ✅ | `app_unit_is_occupied`; API tests for units and properties |
| Staff can carry out the journeys in the console | ✅ | Unit page, resident list and resident page; browser journeys on desktop and phone with axe WCAG 2.2 AA checks |
| Residents see their own homes only | ✅ | "Your homes" from `my-units`; the unit page shows owners and tenants who lives there, household members the unit only; residents never reach the property (browser tests; API Part 2 tests) |
| Staff pick people only from their property or unattached profiles | ✅ | `GET …/properties/:id/persons` (API integration test: another property's resident is not offered; browser test) |

## 2. Product requirements (PRD 3.2)

| Requirement | Status |
| ----------- | ------ |
| Separate user identity from resident profile and membership | ✅ Persons are profiles; a login is linked only by accepting an email-bound resident invitation |
| Owner, tenant and household relationships | ✅ Committee, staff and vendor relationships come with their modules |
| Multiple units per person | ✅ The resident list shows every unit and role per person |
| Ownership and tenancy periods with effective dates | ✅ |
| Move-in, move-out, access revocation | ✅ Ending or voiding a record removes derived access from the next request. Suspension of a resident (as opposed to ending a record) is not modelled |
| Emergency contacts and vehicles only when necessary | ✅ Optional; personal data limited to name, email, phone and language (decision 2026-11-09) |
| Invite users and verify contact channels | ⚠️ Invitations are email-bound, but sign-up still does not verify email ownership (Phase 2 open item) |
| Sensitive identity documents with separate permissions and access logs | ⏳ Not stored; comes with document management (Phase 10) |

## 3. Verification at the time of review

Run locally on 2026-11-11 (Windows 11, Node 24.22, Bun 1.4.4, Docker Desktop with PostgreSQL 17
and Redis 7).

| Suite | Result |
| ----- | ------ |
| Typecheck (18 workspaces), build (12) | ✅ |
| Lint (Biome) | ✅ for the repository. Locally it also reported an untracked, git-ignored `.vscode/settings.json` created by the editor |
| Unit tests | ✅ 223 (API 142, console 30, domain 20, db 9, worker 6, other packages 16) |
| Integration, real PostgreSQL 17 | ✅ db 82, API 105 including the 5 Redis tests (run with `REDIS_URL` set). One API case in `organisations.int.test.ts` failed once under heavy machine load and passed on three reruns (section 5) |
| Browser journeys (Playwright, desktop and phone, axe WCAG 2.2 AA) | ✅ 50 against the production build with one worker, on port 3005 because a dev server held 3000. Two runs of one existing test (`console.spec.ts`, safe redirect) failed only because it expects the literal `localhost:3000` in the URL; the redirect itself behaved correctly |
| Console requests against the real API | ✅ Checked by hand with a script: every create, end, void and delete call of the new screens, plus the expected refusals (backdated transfer, shares not adding up, voiding one co-owner, invitation without email) and the CORS preflight for `DELETE` |
| CI `verify` | ✅ #17-#19 green before merge; Part 4 to be confirmed on its PR |

Defects found and fixed during Part 4: test locators that matched both a label and a button's
accessible name ("Owners from" and "Void owners from …"). The console's browser tests time out
against a `next dev` server; they are meant for the production build, now noted in the console
README.

## 4. Design review

| Area | Assessment |
| ---- | ---------- |
| Authorisation | The console shows controls from the `permissions` the API returns and asks for resident data only when the role holds `property.resident.read`; the API enforces every rule regardless |
| Record integrity | The console never edits a record in place: periods are ended, mistakes are voided with a reason (kept in history and shown as voided). Owners recorded together are voided together, matching the database rule |
| Dates | Defaults and statuses use today in the property's IANA time zone, not the viewer's; calendar dates are formatted without time-zone shifts |
| Money-like values | Shares are typed and sent as integer fractions; no floating point anywhere in the path |
| Accessibility | Every field labelled, errors announced, native confirm and prompt dialogs, no horizontal scroll at phone width; axe clean on the new pages |
| Module boundaries | Console pages use shared helpers (`lib/residents.ts`) and shared components; no business rule is duplicated beyond fast client-side feedback that mirrors the API |

## 5. Open items

### Still required before a pilot stores real data (from the Phase 2 review, unchanged)

MFA, email verification and password reset; structured JSON logging with redaction; secret
scanning in CI; console Content-Security-Policy; production database roles and tested backups;
an automated full-stack smoke test (console + API + PostgreSQL + Redis).

### New in Phase 4, can wait

- Type-ahead search in the people picker (the endpoint supports `query`; the console lists up
  to 200).
- Console support for vehicles linked to a person, archived vehicles, archiving profiles,
  resident list paging and search.
- A design-system dialog to replace the native prompt for void reasons.
- Resident suspension (distinct from ending a record).
- Watch CI for a repeat of the intermittent `organisations.int.test.ts` failure.

### Must be added in Phase 5

- Visitor pre-registration must check derived resident access at the time of use, never a
  cached copy (stale permissions must not grant entry).

## 6. Documentation

Up to date: ROADMAP (Phase 4 done, Docker verified, technical debt), TESTING_STRATEGY (Part 4),
CHANGELOG, console README (screens, structure, how to run browser tests).

# Phase 13 exit review: SaaS administration and subscriptions

- **Date:** 2026-11-12
- **Scope:** PRs #64 (plans, subscriptions and entitlements), #65 (platform administration), #66
  (support access), #67 (screens), and this review
- **Decision:** Phase 13 is complete. Proceed to Phase 14 (security hardening and commercial
  launch), whose first parts close the pilot-readiness items carried since Phase 2 (MFA above
  all, which platform administrators now need too).

Decisions (2026-11-12, the recommended options): three plans kept in the database with features
and limits; every permission belongs to a feature; existing organisations moved to Enterprise
with no change, new ones get a 30-day Enterprise trial; a cancelled subscription or an ended trial
makes the organisation read-only, payment overdue keeps it working; no billing provider yet, so
platform administrators change plans; platform administrators see no tenant data; support access
is asked for with a reason, approved by the organisation, read-only, time-boxed and revocable.

## 1. Exit criteria

| Criterion | Status | Evidence |
| --------- | ------ | -------- |
| Features follow the plan on every request | ✅ | Permissions of features outside the plan are removed whenever access is evaluated; a permission without a feature does not compile (unit, API tests) |
| Limits cannot be bypassed | ✅ | Property and unit limits in database triggers, 409 `PLAN_LIMIT_REACHED` (db, API tests) |
| Lapsed subscriptions are safe | ✅ | Read-only, not deleted or hidden; admins still see why (API tests, browser journey) |
| Subscriptions change only deliberately and visibly | ✅ | The application role cannot write them; platform functions need a reason and write the customer's history and audit log (db, API tests) |
| Platform staff do not see tenant data by default | ✅ | Separate read policies for organisations and subscriptions only; usage as counts; 404 to non-staff (db, API tests) |
| Support access is the customer's decision | ✅ | Requested through a function, decided by the organisation (never the requester), read-only, time-boxed, revocable, audited (db, API tests, browser journey) |
| Granting platform administration is an operator action | ✅ | Only the database owner writes `platform_admins`; revocation is immediate (db tests, runbook) |

## 2. Product requirements (ROADMAP stage 5, ACCESS_CONTROL rules 5 and platform roles)

| Requirement | Status |
| ----------- | ------ |
| Subscriptions, entitlements and usage management | ✅ Plans, features, limits, usage counts, history |
| Platform administration | ✅ Organisations, plans, suspension (API and admin tool) |
| Audited, time-boxed support access visible to the tenant | ✅ |
| Billing provider, invoices for subscriptions, self-service upgrades | ⚠️ Not yet (no provider chosen) |
| Staff SSO and MFA for platform administrators | ⚠️ Waits for MFA (Phase 14) |

## 3. Verification at the time of review

Run locally on 2026-11-12 (Windows 11, Node 24, Bun 1.4.4; Docker not running, so the Redis tests
ran only in CI).

| Suite | Result |
| ----- | ------ |
| Lint, typecheck (18 workspaces), build (12) | ✅ |
| Unit tests | ✅ API 233, console 64, admin 4, worker 19 |
| Integration, real PostgreSQL | ✅ db 309; API all but the 5 Redis tests (pass in CI) |
| Browser journeys (desktop and phone, axe WCAG 2.2 AA) | ✅ 118 of 118 with one worker |
| CI `verify` | ✅ #64-#67 green before merge |

## 4. Design review

| Area | Assessment |
| ---- | ---------- |
| Enforcement point | Entitlements and lapse are applied where grants are loaded, so every guard, list filter and permission check sees the same answer; the console follows the returned permissions |
| Database as the last line | Limits, subscription writes, platform actions and support decisions are enforced by triggers, policies and functions that check the caller again |
| Owner-run functions | Row-level security binds the owner too (FORCE), so the functions act inside the target organisation's context and restore it; new write policies are scoped to that context |
| Module boundaries | `subscriptions` (organisation view), `platform-admin` (staff and support access); access-control owns the feature map and the derived `SUPPORT_AGENT` role |
| Dependencies | None added |

## 5. Open items

### Owner decisions

- A billing provider for subscriptions (and whether customers upgrade themselves).
- Trial length and reminders before a trial ends.

### Still required before a pilot stores real data (unchanged from Phase 2, now Phase 14)

MFA (also for platform administrators), email verification and password reset; structured JSON
logging with redaction; secret scanning in CI; console Content-Security-Policy; production
database roles and tested backups; an automated full-stack smoke test; malware scanning of
uploads.

### New in Phase 13, can wait

- Notifying organisation admins of support requests; auditing reads during support access.
- Browser journeys for the admin tool.
- Editing plans from the admin tool (plans change by migration today).

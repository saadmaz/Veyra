# Phase 8 exit review: Facilities and reservations

- **Date:** 2026-11-12
- **Scope:** PRs #38 (data foundation), #39 (roles and API), #40 (fees and deposits through the
  ledger), #41 (console screens and browser journeys), and this review
- **Decision:** Phase 8 is complete. Proceed to Phase 9 (staff, vendors and assets). The
  pilot-readiness items from the Phase 2 review are still open.

Owner decisions (2026-11-12, the recommended options): owners and tenants book, household members
only when delegated (delegation is not built, so they do not book yet), staff on a resident's
behalf; fees and deposits charged to the unit's account through the Phase 6 ledger; approval is a
per-facility setting; fixed-length slots inside weekly opening hours.

## 1. Exit criteria

| Criterion | Status | Evidence |
| --------- | ------ | -------- |
| No overbooking, even under concurrency | ✅ | Capacity, closures, windows and the per-unit limit checked by the database under a per-facility advisory lock; two connections racing for one slot: the second is refused (db tests) |
| Bookings are whole slots inside opening hours, in the property's time zone | ✅ | Database check on the local day; availability computed in PostgreSQL with the property's IANA zone (db, API tests) |
| Approval as the facility says, whatever the client sends | ✅ | Status set by the database on insert; decider recorded; transitions with reasons (db, API tests) |
| Residents see and act only on their own unit | ✅ | Unit-scoped routes; other units 404; availability never shows who booked (API tests, browser journeys) |
| Money is exact and traceable | ✅ | Fee and deposit fixed on the booking by the database; invoice issued in the booking's own transaction through the finance rules; cancellations and deposit releases are credit notes; a booking links to one issued invoice of its unit, once (db, API tests) |
| Full, honest history | ✅ | Booking events written only by the database with the actor; append-only even for the superuser (db tests) |
| Tenant and property isolation | ✅ | RLS on every facility table; other organisations and properties see nothing (db, API tests) |

## 2. Product requirements (PRD 3.6)

| Requirement | Status |
| ----------- | ------ |
| Configure facilities, hours, capacity, slots, fees, deposits and rules | ✅ |
| Show availability in the property's time zone | ✅ |
| Prevent overlapping reservations transactionally | ✅ |
| Approval, cancellation, no-show and maintenance blackout | ✅ Closures can cancel the bookings they cover, with the reason |
| Waitlist | ⏳ Later (PRD) |
| Track refunds and deposits through finance workflows | ⚠️ Unpaid amounts are credited automatically; paid ones are refunded through the existing finance steps (release, credit, approved refund); keeping a deposit for damage is a manual journal |
| Per-unit and per-user booking limits | ⚠️ Per unit (all residents of a home share it); no separate per-user limit |

## 3. Verification at the time of review

Run locally on 2026-11-12 (Windows 11, Node 24, Bun 1.4.4; Docker not running, so the Redis
tests ran only in CI).

| Suite | Result |
| ----- | ------ |
| Lint, typecheck (18 workspaces), build (12) | ✅ |
| Unit tests | ✅ API 209, console 58 |
| Integration, real PostgreSQL | ✅ db 251; API all except the 5 Redis tests, which need a local Redis and pass in CI |
| Browser journeys (desktop and phone, axe WCAG 2.2 AA) | ✅ 94 of 94 with one worker; with many workers this machine times out at random |
| CI `verify` | ✅ #38-#41 green before merge |

Defects found during the phase and fixed: the ledger's truncate-immutability test listed every
table referencing invoices, so the new booking link made it fail in CI until bookings were
added; the shell's `NODE_ENV=development` breaks `next build` locally (CI is unaffected).

## 4. Design review

| Area | Assessment |
| ---- | ---------- |
| Authorisation | Three permissions: `unit.facility.book` (owners, tenants; staff on behalf), `property.facility.read` (also security supervisors), `property.facility.manage`; the residents' cancellation window is enforced by the API |
| Integrity | Every rule in the API is repeated by the database under the facility lock; the database owns status on insert, slot counts, money snapshots and timestamps |
| Module boundaries | Facilities charge through finance's exported `BookingChargesService` on the caller's transaction (an opaque `TransactionHandle`), reusing finance's own invoice, issue and credit-note code; no finance logic is duplicated |
| Accounting | Deposits book to a liability (Facility deposits held), not income; charge types may now book to a liability for money held |
| Privacy | Availability shows places left only; audit entries hold ids and amounts, no free text |
| Dependencies | None added |

## 5. Open items

### Still required before a pilot stores real data (unchanged from Phase 2)

MFA, email verification and password reset; structured JSON logging with redaction; secret
scanning in CI; console Content-Security-Policy; production database roles and tested backups;
an automated full-stack smoke test.

### New in Phase 8, can wait

- Household delegation (then household members may book).
- Waitlists; a per-user limit beside the per-unit one.
- Retaining a deposit for damage as a booking action (today a manual journal by finance).
- Different opening hours per day in the console forms (the API already supports them).
- Notifications for approvals, rejections and closures (Phase 10).
- A worker job marking past confirmed bookings used, and booking screens in the resident app.

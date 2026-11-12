# Phase 9 exit review: Staff, vendors and assets

- **Date:** 2026-11-12
- **Scope:** PRs #43 (vendors), #44 (assets and preventive maintenance), #45 (departments, shifts
  and handovers), #46 (checklists and inspections), #47 (console screens), and this review
- **Decision:** Phase 9 is complete. Proceed to Phase 10 (communications and documents), which
  also brings the notifications several Phase 7-9 features are waiting for. The pilot-readiness
  items from the Phase 2 review are still open.

Decisions (2026-11-12, the recommended options; the owner asked to proceed with
recommendations): vendors belong to the organisation and get no login yet; quotations, purchase
requests and orders wait for a later phase (PRD 3.8 allows phasing); assets belong to a property
and schedules raise work orders when due; departments, shifts with handovers and checklists with
supervisor verification; no attendance or leave integration (PRD: only after legal review).

## 1. Exit criteria

| Criterion | Status | Evidence |
| --------- | ------ | -------- |
| Work goes only to vendors who may take it | ✅ | Active vendors only (database and API); every vendor change logged by the database (db, API tests) |
| Compliance is visible | ✅ | Expired, expiring within 30 days, or none on file, from documents not voided (API tests, browser journey) |
| Preventive work is raised once per due date | ✅ | Unique key per schedule and date; a second run raises nothing; missed periods skipped (db, API, unit tests) |
| Equipment history is honest | ✅ | Work on an asset is at its place; links never change; retiring waits for paused schedules and finished work (db, API tests) |
| A person is never on two shifts at once | ✅ | Checked under a lock per person; two connections at once: the second refused (db tests) |
| Handovers reach the next shift | ✅ | Ending needs a note; the next shift of the department reads it (API tests, browser journey) |
| Checklists are complete and checked by someone else | ✅ | Every check answered before handing in; a failed check needs a note; the person who did it never verifies it (db, API tests, browser journey) |
| Staff see only their own work | ✅ | Other people's shifts and checklists are 404 (API tests) |
| Tenant isolation | ✅ | RLS on all ten new tables; no DELETE grants (db tests) |

## 2. Product requirements

| Requirement | Status |
| ----------- | ------ |
| 3.7 Staff profiles and department assignments | ✅ Departments and members (profiles are the identity accounts) |
| 3.7 Shift schedules and handover notes | ✅ |
| 3.7 Task lists, checklists, inspections and evidence | ⚠️ Checklists with notes as evidence; photos later (the maintenance file storage can be reused) |
| 3.7 Work assignment and escalation | ⚠️ Assignment yes; escalation with notifications in Phase 10 |
| 3.7 Leave and attendance integrations | ⏳ Only if required and legally reviewed |
| 3.7 Task completion and supervisor verification | ✅ |
| 3.8 Asset register with identifiers, location, category, warranty, supplier, lifecycle | ✅ |
| 3.8 Preventive maintenance schedules and service history | ✅ Raised by a manager action; a daily worker job is a follow-up |
| 3.8 Vendor records, qualifications, contracts, insurance and expiry dates | ✅ Recorded without files |
| 3.8 Quotations, purchase requests, orders, invoice matching | ⏳ Later (allowed to be phased) |
| 3.8 Vendor portal limited to assigned work | ⏳ Later (vendors have no login yet) |

## 3. Verification at the time of review

Run locally on 2026-11-12 (Windows 11, Node 24, Bun 1.4.4; Docker not running, so the Redis tests
ran only in CI).

| Suite | Result |
| ----- | ------ |
| Lint, typecheck (18 workspaces), build (12) | ✅ |
| Unit tests | ✅ API 213, console 58 |
| Integration, real PostgreSQL | ✅ db 271; API all but the 5 Redis tests (pass in CI) |
| Browser journeys (desktop and phone, axe WCAG 2.2 AA) | ✅ 98 of 98 with one worker |
| CI `verify` | ✅ #43-#47 green before merge |

Defects found during the phase and fixed: a formatting slip after a test edit failed CI on #43; a
console journey showed that a failed check without a note got a generic error, so the page now
explains it before sending.

## 4. Design review

| Area | Assessment |
| ---- | ---------- |
| Module boundaries | Trades moved to `@veyra/domain` so vendors and maintenance share them without a cycle; maintenance reads vendors through the vendors module's service |
| Authorisation | `organisation.vendor.read/manage`; `property.staff.read/manage/work`; assets use the maintenance permissions. Supervisors manage every department of their property |
| Integrity | Every status machine is enforced by the database with reasons where needed; times and actors set by the database |
| Dependencies | None added |

## 5. Open items

### Still required before a pilot stores real data (unchanged from Phase 2)

MFA, email verification and password reset; structured JSON logging with redaction; secret
scanning in CI; console Content-Security-Policy; production database roles and tested backups;
an automated full-stack smoke test.

### New in Phase 9, can wait

- A daily worker job to raise preventive work and to remind about expiring vendor documents.
- Photos on checklists and vendor documents (reuse the maintenance file storage).
- Per-department supervisors; recurring checklists.
- Vendor portal, quotations and purchase orders.
- Asset browser journey; editing templates and vendor details in the console.

# Phase 7 exit review: Maintenance and work orders

- **Date:** 2026-11-12
- **Scope:** PRs #33 (data foundation), #34 (roles and API), #35 (file storage and
  attachments), #36 (SLAs, breaches and the outbox relay), and Part 5 (console screens and
  browser journeys, this change)
- **Decision:** Phase 7 is complete. Proceed to Phase 8 (facilities and reservations) once the
  owner has reviewed this document. Notifications of updates and breaches arrive with Phase 10;
  vendors with Phase 9. The pilot-readiness items from the Phase 2 review are still open.

Owner decisions (2026-11-11): owners, tenants and household members raise requests (staff too,
also for common areas); photo evidence is in scope, so Phase 7 added object storage; costs are
recorded for reporting only; Maintenance Manager and Technician roles per property, technicians
see only their own work; SLA targets per priority per property, breaches flagged by a worker job.

## 1. Exit criteria

| Criterion | Status | Evidence |
| --------- | ------ | -------- |
| A request moves only along allowed transitions, with the reasons they need | ✅ | Database triggers and API checks (db, API tests); final states never change |
| A request is resolved only when its work is done | ✅ | Database check under a per-request advisory lock; API 409 (db, API tests) |
| Full, honest history | ✅ | Status, assignee, priority and breach events written by the database with the actor; append-only even for the superuser; notes only from the application (db tests) |
| Residents see only what is theirs and meant for them | ✅ | Unit-scoped routes; resident-visible history and files only; other units 404 (API tests, browser journeys) |
| Technicians see only their own work | ✅ | `my-work-orders` routes; others' work 404; no queue or resident data (API tests, browser journeys) |
| Work goes only to people who may do it | ✅ | Assignee must hold `property.maintenance.work` at the property, by the same policy as every request (API tests) |
| Files are what they claim and stay private | ✅ | Uploads signed for exact type and size (contract test against a signature-checking server), content sniffed before use, tenant-prefixed server keys, 5-minute links (ADR 0007) |
| SLA breaches are true and recorded once | ✅ | Recorded only by the database when the target passed unmet; scheduled through the outbox; idempotent job; overdue also computed on read (db, API, worker tests) |
| Tenant and property isolation | ✅ | RLS on every maintenance table; other organisations and properties see nothing (db, API tests) |

## 2. Product requirements (PRD 3.5)

| Requirement | Status |
| ----------- | ------ |
| Resident request submission with category, description, location, priority, attachments | ✅ |
| Triage, assignment, status tracking, internal notes, resident-visible updates | ✅ |
| Convert requests into work orders | ✅ Several per request; staff can also raise work directly for a place |
| Configure priority and service targets per property | ✅ |
| Record labour, materials, costs, vendor, evidence and completion | ⚠️ Labour, materials, other costs, before/after photos and completion notes; vendors in Phase 9 |
| Resident confirmation and reopening | ✅ |
| Track SLA breaches and escalation | ⚠️ Breaches tracked and shown first in the queue; escalation by notification in Phase 10 |
| Maintain full history | ✅ |

## 3. Verification at the time of review

Run locally on 2026-11-12 (Windows 11, Node 24, Bun 1.4.4, Docker running).

| Suite | Result |
| ----- | ------ |
| Lint, typecheck (18 workspaces), build (12) | ✅ |
| Unit tests | ✅ API 202, console 55, worker 12, domain 20, db 9, design tokens 4, other packages 13 |
| Integration, real PostgreSQL 17 | ✅ db 235, API 194, including the Redis tests and the S3 contract test against SeaweedFS |
| Browser journeys (desktop and phone, axe WCAG 2.2 AA) | ✅ 90 of 90 with two workers |
| CI `verify` | ✅ #33-#36 green before merge; Part 5 to be confirmed on its PR |

Defects found by tests during the phase and fixed: history events written in one transaction
shared a timestamp, so their order was ambiguous (a `sequence` column now orders them); the
warning colour was 4.25:1 on the page background (now 5.08:1, with a contrast test for every
status colour in both themes); the resident unit page overflowed on phones with a long button in
a card header.

## 4. Design review

| Area | Assessment |
| ---- | ---------- |
| Authorisation | Four maintenance permissions and two new roles; "own work" and "own unit" narrowing in the services; confirming and reopening need a current resident role |
| Integrity | Every transition rule is in the API and repeated by the database; timestamps, due times and breaches owned by the database |
| Privacy | Technicians see the place and the problem, not who reported it; residents never see internal notes, work orders, assignees or costs; audit entries hold ids, no free text |
| Asynchronous work | The transactional outbox and its relay (designed in ARCHITECTURE section 5) now exist; jobs carry tenant envelopes and run under RLS |
| Dependencies | `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` (ADR 0007). MinIO images are no longer published, so local and CI storage is SeaweedFS |

## 5. Open items

### Still required before a pilot stores real data (unchanged from Phase 2)

MFA, email verification and password reset; structured JSON logging with redaction; secret
scanning in CI; console Content-Security-Policy; production database roles and tested backups;
an automated full-stack smoke test. For files: malware scanning, and bucket CORS for the console's
origin.

### New in Phase 7, can wait

- Notifications to residents about updates and to managers about breaches (Phase 10).
- Vendors on work orders (Phase 9).
- Cleanup jobs: uploads never completed, published outbox rows.
- An end-to-end test of worker, Redis and database together.
- Paging for request and work order lists (200 most recent); the queue shows at most 500.
- Void reasons for costs use the browser's prompt (as elsewhere), to be replaced by a dialog.

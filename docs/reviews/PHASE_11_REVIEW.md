# Phase 11 exit review: Governance and incident management

- **Date:** 2026-11-12
- **Scope:** PRs #54 (incidents), #55 (committees and meetings), #56 (approval policies), #57
  (console screens), and this review
- **Decision:** Phase 11 is complete. Proceed to Phase 12 (analytics and integrations). Voting
  stays out of the application until its legal and governance requirements are validated
  (PRD 3.11). The pilot-readiness items from the Phase 2 review are still open.

Decisions (2026-11-12, the recommended options): incidents per property reported by staff, with
severity, an append-only timeline, follow-ups that must be done before closing, sensitive records
for managers and the reporter only, escalation contacts per kind, and alerts to managers for high
and critical reports; a Committee member role, committees with seats for terms (one chair at a
time), meetings with agendas, minutes approved once and resolutions recorded with their vote
counts but no voting in the application; approval policies by request type and amount, approved
by managers or the current members of a committee. VEYRA does not replace emergency services.

## 1. Exit criteria

| Criterion | Status | Evidence |
| --------- | ------ | -------- |
| Incident records are trustworthy | ✅ | What was reported never changes; the database runs the status machine, needs an outcome to resolve and every follow-up done to close, and writes the timeline itself (db, API tests) |
| Sensitive incidents stay with the people who need them | ✅ | Managers and the reporter only; others get 404 in lists and detail; alerts carry no details (API tests) |
| Managers are alerted at once | ✅ | High and critical reports notify incident managers in-app and by email in the same transaction (API test) |
| Committee membership is consistent | ✅ | Exclusion constraints: one seat per person and one chair per committee at a time; a term ends once; seats only for Committee members (db, API tests) |
| Decision records are permanent | ✅ | Minutes approved once, by a person, then final; resolutions numbered and never changed or deleted (db, API tests) |
| Approvals follow the policy and cannot be gamed | ✅ | The policy is copied onto the request; nobody decides their own request or for someone else; once per person; settled only by the database; one rejection with a reason settles it (db, API tests) |
| Tenant isolation | ✅ | RLS on all twelve new tables; no DELETE grants (db tests) |
| Usable screens | ✅ | Three journeys on desktop and phone with axe WCAG 2.2 AA (browser tests) |

## 2. Product requirements

**PRD 3.10 Incidents and emergencies**

| Requirement | Status |
| ----------- | ------ |
| Incident reports with category, severity, location, time and evidence | ⚠️ All but photos (attachments later, through the maintenance upload path) |
| Response timeline and follow-up actions | ✅ |
| Restrict sensitive incident records | ✅ |
| Escalation contacts and procedures | ⚠️ Contacts per kind, in order; written procedures through Documents |
| Emergency broadcasts with confirmation and audit | ✅ Urgent announcements with acknowledgement (Phase 10) |
| Operational playbooks and post-incident actions | ⚠️ Post-incident follow-ups yes; playbooks per kind later |
| Do not imply the software replaces emergency services | ✅ Stated on the incidents page |

**PRD 3.11 Governance and approvals**

| Requirement | Status |
| ----------- | ------ |
| Committee members and terms | ✅ |
| Meetings, agendas, minutes and resolutions | ✅ |
| Configurable approval policies and thresholds | ✅ |
| Expense, procurement, policy and access approval workflows | ⚠️ The decision workflow for every type; an approval does not yet raise an expense or purchase order (no such records yet) |
| Voting only after legal validation | ✅ Not built; resolutions record counts taken at the meeting |
| Preserve decision records and supporting documents | ✅ |

## 3. Verification at the time of review

Run locally on 2026-11-12 (Windows 11, Node 24, Bun 1.4.4; Docker not running, so the Redis tests
ran only in CI).

| Suite | Result |
| ----- | ------ |
| Lint, typecheck (18 workspaces), build (12) | ✅ |
| Unit tests | ✅ API 224, console 62 |
| Integration, real PostgreSQL | ✅ db 295; API all but the 5 Redis tests (pass in CI) |
| Browser journeys (desktop and phone, axe WCAG 2.2 AA) | ✅ 108 (one phone journey failed once under full-suite load and passes on its own) |
| CI `verify` | ✅ #54-#57 green before merge |

## 4. Design review

| Area | Assessment |
| ---- | ---------- |
| Module boundaries | New `incidents` and `governance` modules; both notify through `NotificationsService` on their own transaction; governance reads committee seats for approvals inside its own module |
| Database as the last line | Every state machine, the timeline, minutes approval, resolution permanence and approval settlement are enforced by triggers and constraints, not only by services |
| Authorisation | `property.incident.*`, `property.governance.*`, `property.approval.*` and the Committee member role; approver eligibility (decide permission or a current seat) is checked by the service, self-approval and impersonation also by the database |
| Privacy | Sensitive incidents hidden as 404; alert bodies omit sensitive details; committee members see governance and documents only |
| Dependencies | None added |

## 5. Open items

### Still required before a pilot stores real data (unchanged from Phase 2)

MFA, email verification and password reset; structured JSON logging with redaction; secret
scanning in CI; console Content-Security-Policy; production database roles and tested backups;
an automated full-stack smoke test; malware scanning of uploads.

### New in Phase 11, can wait

- Photos and files on incidents; playbooks per kind of incident; residents reporting incidents.
- Attendance and quorum for meetings; committee members drafting minutes; publishing approved
  minutes to residents.
- Escalation or expiry of approval requests left pending; approvals raising expense or purchase
  records once those exist.
- Console: renaming and dissolving committees, editing escalation contacts, choosing a unit or
  common area when reporting.

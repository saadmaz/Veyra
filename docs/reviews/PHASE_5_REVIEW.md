# Phase 5 exit review: Visitor and access management

- **Date:** 2026-11-11
- **Scope:** PRs #22 (data foundation), #23 (security roles and visitor API), #24 (walk-in
  approval), #25 (visitor console), and Part 5 (offline gate and paper log, this change)
- **Decision:** Phase 5 is complete. Proceed to Phase 6 (finance and billing) once the owner has
  reviewed this document. Instant delivery of walk-in requests and opening the gate screen
  without a connection remain open (section 5). The pilot-readiness items from the Phase 2
  review are still open.

Owner decisions (2026-11-11): owners, tenants, household members and staff register visitors;
visitor data is name, optional phone and optional plate; walk-ins to a unit need the resident's
in-app approval; both a paper procedure and an offline gate mode; offline lists are trusted for
4 hours; guards admit on offline checks themselves; flagged entries go to supervisor review.

## 1. Exit criteria

| Criterion | Status | Evidence |
| --------- | ------ | -------- |
| A pass is random, time-limited, revocable and reveals no personal data | ✅ | 256-bit QR token and 8-character code, stored as SHA-256 hashes only (db tests); shown once to the inviter (API and browser tests) |
| A pass is never proof of identity; guards see the minimum | ✅ | Guards see name, type, plate, unit and window, never phones or resident names (API and browser tests); every screen says to check identity |
| No entry beyond what the pass allows, even under concurrency | ✅ | Database backstop under a row lock: window, revocation, entries, live pass; two gates racing for the last entry: one wins (db and API tests) |
| Stale access never grants entry | ✅ | Pass stops at once when the host no longer lives there (API test); offline lists refused after 4 hours (unit test); late entries re-checked at the time they happened and flagged (db, API, browser tests) |
| Nobody enters a home without a resident's yes | ✅ | Walk-ins to a unit need an approved, unused approval within 15 minutes, enforced by the database; staff cannot approve; impossible offline (db, API, browser tests) |
| Records tell the truth | ✅ | Visits are immutable except departure and review, each once; paper and offline entries keep the time they happened and are never refused for being wrong, only flagged; access events append-only even for the superuser |
| Tenant and property isolation | ✅ | RLS and composite keys on every visitor table; a pass does not work at another property's gate; other properties' guards get 404 (db and API tests) |

## 2. Product requirements (PRD 3.3)

| Requirement | Status |
| ----------- | ------ |
| Resident pre-registration | ✅ Owners, tenants, household members and staff |
| Time-bounded, revocable passes | ✅ Up to 31 days, 1-50 entries |
| QR or reference-code validation | ✅ Code typed in any case and spacing; QR scanned where the browser supports it (Chromium) |
| Manual check-in without a pass | ✅ Walk-in requests approved by a resident; walk-ins to the property recorded directly |
| Arrival, departure, gate, operator, vehicle | ✅ |
| Delivery, contractor, service provider, guest | ✅ |
| Minimum information for security staff | ✅ |
| Denied entry and incident escalation | ⚠️ Denials recorded with a reason; incident escalation arrives with incident management (Phase 11) |
| Offline contingency for gate operations | ✅ Paper procedure ([GATE_OFFLINE](../operations/GATE_OFFLINE.md)) and offline mode while the screen is open; opening the screen offline is not supported yet |
| Hardware through provider adapters | ⏳ Not started (Phase 12) |
| A QR code alone is never proof of identity | ✅ |

## 3. Verification at the time of review

Run locally on 2026-11-11 (Windows 11, Node 24, Bun 1.4.4).

| Suite | Result |
| ----- | ------ |
| Lint, typecheck (18 workspaces), build (12) | ✅ |
| Unit tests | ✅ API 158, console 40, domain 20, db 9, worker 6, other packages 16 |
| Integration, real PostgreSQL 17 | ✅ db 114, API 125. The 5 Redis tests were skipped in the last local run because Docker Desktop was not running; they ran and passed on every Phase 5 PR in CI |
| Browser journeys (desktop and phone, axe WCAG 2.2 AA) | ✅ 66 of 68 locally; the 2 failures are the existing safe-redirect test asserting `localhost:3000` while the run used port 3005. It passes in CI |
| CI `verify` | ✅ #22-#25 green before merge; Part 5 to be confirmed on its PR |

Defects found by tests during the phase and fixed: a crash (500) for times without a zone; three
label-in-name accessibility failures; a list that did not refresh after an admission; an
intermittent membership test (database vs API clock).

## 4. Design review

| Area | Assessment |
| ---- | ---------- |
| Authorisation | Four visitor permissions, two security roles granted per property; answering a walk-in needs a derived resident role, not just the permission |
| Integrity | Every critical rule is in the API and repeated in the database (CHECK constraints, triggers, unique keys) |
| Privacy | Visitor data limited by owner decision; guards and offline lists carry no phone numbers; offline lists expire after 4 hours |
| Dependencies | One added: `qrcode-generator` (MIT, no dependencies) to draw QR codes |
| Operations | Gate procedure documented for guards and supervisors |

## 5. Open items

### Still required before a pilot stores real data (unchanged from Phase 2)

MFA, email verification and password reset; structured JSON logging with redaction; secret
scanning in CI; console Content-Security-Policy; production database roles and tested backups;
an automated full-stack smoke test.

### New in Phase 5, can wait

- Instant delivery of walk-in requests (WebSockets, then push notifications); today residents
  must have the app open (polling every 5 seconds).
- A service worker so the gate screen opens without a connection.
- QR scanning outside Chromium browsers (a scanning library, if pilots need it).
- Retention periods for visit records, access events and paper log books per jurisdiction.
- Access-control hardware adapters (Phase 12) and incident escalation from a denial (Phase 11).

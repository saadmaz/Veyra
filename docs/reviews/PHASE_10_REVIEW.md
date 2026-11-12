# Phase 10 exit review: Communications and documents

- **Date:** 2026-11-12
- **Scope:** PRs #49 (announcements), #50 (notifications and the delivery worker), #51
  (documents), #52 (console screens), and this review
- **Decision:** Phase 10 is complete. Proceed to Phase 11 (governance and incident management).
  Before real email leaves the system, the owner chooses an email provider (only a logging
  adapter exists). The pilot-readiness items from the Phase 2 review are still open.

Decisions (2026-11-12, the recommended options): announcements per property for everyone,
residents, one building or staff, with an urgent flag and optional acknowledgement; in-app first,
then email, SMS and push behind provider-neutral adapters (no real provider yet, as with
payments); documents per property with categories, audiences, versions and expiry dates in the
existing object storage.

## 1. Exit criteria

| Criterion | Status | Evidence |
| --------- | ------ | -------- |
| Messages reach exactly their audience | ✅ | Audience resolved at publishing from today's residents (by the property's local date) and staff; people outside see nothing (db, API tests, browser journey) |
| Reads and acknowledgements are honest | ✅ | Only the recipient updates their copy, each once; acknowledging only where asked (db, API tests) |
| Published content is fixed | ✅ | Database refuses changes after publishing; withdrawal with a reason, final (db tests) |
| Notifications exist exactly when their change does | ✅ | Written by the changing module on its own transaction (booking decisions, maintenance updates, urgent announcements) (API tests) |
| Deliveries are retried and their outcome recorded truthfully | ✅ | Outbox event per delivery; the application cannot update deliveries; outcomes only through a security-definer function counting attempts (db, worker tests) |
| No personal data in delivery logs | ✅ | The logging adapter writes only the delivery id (worker test) |
| Documents are what they claim and reach only their audience | ✅ | Signed uploads, content sniffed before use, false files deleted; owners' documents for owners only; five-minute links (db, API tests, browser journey) |
| Tenant isolation | ✅ | RLS on all six new tables; no DELETE grants (db tests) |

## 2. Product requirements (PRD 3.9)

| Requirement | Status |
| ----------- | ------ |
| Property-wide, building, unit, role and targeted announcements | ⚠️ Property, building, residents and staff; unit-level and role-specific audiences later |
| In-app and push notifications, with email/SMS adapters | ⚠️ In-app and email (logging adapter); SMS and push need phone numbers and device tokens |
| Delivery status and retry visibility | ✅ Attempts, last error and failures shown to managers |
| Templates and emergency broadcast workflow | ⚠️ Urgent broadcasts by email and inbox; message templates later |
| Resident acknowledgement where required | ✅ |
| Document categories, metadata, access policy, versioning, retention, expiry reminders | ⚠️ All but retention rules and reminder notifications (expiry shown on each document) |
| Secure download links with short expiry and access checks | ✅ |

## 3. Verification at the time of review

Run locally on 2026-11-12 (Windows 11, Node 24, Bun 1.4.4; Docker not running, so the Redis tests
ran only in CI).

| Suite | Result |
| ----- | ------ |
| Lint, typecheck (18 workspaces), build (12) | ✅ |
| Unit tests | ✅ API 213, console 60, worker 15 |
| Integration, real PostgreSQL | ✅ db 281; API all but the 5 Redis tests (pass in CI) |
| Browser journeys (desktop and phone, axe WCAG 2.2 AA) | ✅ 102 of 102 with one worker |
| CI `verify` | ✅ #49-#52 green before merge |

Defect found during the phase and fixed: the first design let any connection set a session flag
to record delivery outcomes; it was replaced before merging by revoking UPDATE on deliveries and
recording outcomes through a security-definer function.

## 4. Design review

| Area | Assessment |
| ---- | ---------- |
| Module boundaries | Communications exports `NotificationsService`; facilities and maintenance notify on their own transaction through the opaque `TransactionHandle` (as finance charges do) |
| Asynchronous work | Deliveries use the outbox and worker built in Phase 7; jobs run in the tenant's RLS context; duplicates are harmless |
| Authorisation | `property.announcement.*`, `property.document.*`, `unit.document.read`; inbox and notification feeds need only sign-in and show one's own items |
| Privacy | Delivery errors and logs carry no addresses or content; residents never see who else received an announcement |
| Dependencies | None added |

## 5. Open items

### Owner decisions before real messages are sent

- Email provider (SES, Postmark, SendGrid, …) and sending domain; SMS provider and whether SMS is
  wanted; push (needs the resident app and device registration).

### Still required before a pilot stores real data (unchanged from Phase 2)

MFA, email verification and password reset; structured JSON logging with redaction; secret
scanning in CI; console Content-Security-Policy; production database roles and tested backups;
an automated full-stack smoke test; malware scanning of uploads.

### New in Phase 10, can wait

- A daily worker job for document and vendor expiry reminders and for preventive work.
- Notification preferences per person; message templates; scheduled announcements.
- Unit- and role-level audiences; document retention rules.
- A notification badge in the console navigation.

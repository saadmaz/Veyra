# Phase 14 exit review: Security hardening and commercial launch

- **Date:** 2026-11-12
- **Scope:** PRs #69 (email verification and password reset), #70 (two-step sign-in), #71
  (operational hardening), #72 (launch readiness), and this review
- **Decision:** Phase 14's engineering work is complete, and with it the fourteen delivery phases
  of AGENTS.md section 16. VEYRA is ready for a **pilot** once the operator and owner items of
  `docs/operations/LAUNCH_CHECKLIST.md` are done for the pilot environment: a penetration test
  before significant commercial deployment, monitoring connected, ClamAV running, keys and roles
  from a secrets manager, and the provider decisions below.

Decisions (2026-11-12, the recommended options): close the pilot-readiness items carried since
Phase 2 first; TOTP for two-step sign-in (WebAuthn later), enforced for privileged changes in
production; JSON logs with redaction; gitleaks and `bun audit` in CI; a strict
Content-Security-Policy; ClamAV for uploads; one container image with a full-stack smoke test and
restore drill in CI.

## 1. The Phase 2 pilot-readiness list

| Item (PHASE_2_REVIEW section 5) | Status |
| ------------------------------- | ------ |
| MFA for privileged users, email verification, password reset, breached-password check | ✅ MFA (TOTP), verification and reset; ⚠️ breached-password check later |
| Structured JSON logging with request ids and redaction | ✅ (the worker still logs plain text) |
| Secret scanning in CI | ✅ gitleaks |
| Content-Security-Policy for the console | ✅ (also the admin tool; inline scripts until nonces) |
| Production database roles from a secrets manager, tested backups | ✅ Roles script, runbook, restore drill in CI; ☐ point-in-time recovery per environment |
| Full-stack smoke test | ✅ In CI on every pull request |
| Malware scanning of uploads (added in Phase 8) | ✅ ClamAV adapter; ☐ running per environment |

## 2. Exit criteria

| Criterion | Status | Evidence |
| --------- | ------ | -------- |
| Accounts can be recovered safely | ✅ | Single-use hashed links, no enumeration, reset ends every session (API, browser tests) |
| Privileged changes need a second factor in production | ✅ | Guard and platform routes; RFC 6238 vectors; replay refused; recovery codes once (unit, API, browser tests) |
| Logs carry no secrets or personal data | ✅ | Redaction tests; JSON in production |
| Uploads cannot deliver malware unnoticed | ✅ | Shared upload check scans before use, fails closed (unit, API tests) |
| The release works as a whole | ✅ | Image, migrations, API, worker and console started together and walked in CI |
| Backups restore | ✅ | Restore drill with identical row counts across 93 tables in CI |

## 3. Verification at the time of review

Run locally on 2026-11-12 (Windows 11, Node 24, Bun 1.4.4; Docker not running locally, so the
Redis tests, the image and the full-stack job ran only in CI).

| Suite | Result |
| ----- | ------ |
| Lint, typecheck (19 workspaces), build (12) | ✅ |
| Unit tests | ✅ API 243, console 66, admin 4, worker 19, emails 7, web-config 5 |
| Integration, real PostgreSQL | ✅ db 309; API all but the 5 Redis tests (pass in CI) |
| Browser journeys (desktop and phone, axe WCAG 2.2 AA) | ✅ 124 of 124 with one worker |
| CI `verify` (with gitleaks and `bun audit`) and `smoke` | ✅ #69-#72 green before merge |

## 4. Design review

| Area | Assessment |
| ---- | ---------- |
| Authentication | Built-in (ADR 0005) now covers verification, reset and TOTP; an external OIDC provider remains possible behind the identity port |
| Enforcement | Rule 7 lives in the permission guard (one place) using the same access result as every other check; reads are never blocked |
| Secrets | Keys per environment (MFA, webhooks), roles from a secrets manager; nothing secret in logs or the repository (scanned) |
| Delivery | One image, additive migrations, rollback by image; smoke test and restore drill prove each change |
| Dependencies | `@veyra/emails` added to the API (templates); no new third-party packages |

## 5. Open items

### Owner decisions

- Email provider and sending domain; payment provider; billing provider and trial reminders;
  whether unconfirmed addresses may accept invitations; SMS and push.

### Operator actions per environment (LAUNCH_CHECKLIST.md)

- Penetration test before significant commercial deployment.
- Managed PostgreSQL with point-in-time recovery, bucket versioning, ClamAV, keys and role
  passwords in a secrets manager, monitoring and alerts (OpenTelemetry, Sentry).
- Terms, privacy notice and data processing agreement per market; retention rules; tenant export
  and deletion procedure.

### Engineering follow-ups

- WebAuthn and breached-password checks; CSP nonces; JSON logs in the worker; a slimmer image;
  the resident mobile app (ADR 0004) and the device and AI stage of the roadmap.

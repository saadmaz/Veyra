# Phase 12 exit review: Analytics and integrations

- **Date:** 2026-11-12
- **Scope:** PRs #59 (dashboards), #60 (exports), #61 (webhooks), #62 (console screens), and
  this review
- **Decision:** Phase 12 is complete. Proceed to Phase 13 (SaaS administration and
  subscriptions). Before webhooks are offered to customers, each environment needs its own
  `WEBHOOK_SIGNING_KEY` (API and worker). The pilot-readiness items from the Phase 2 review are
  still open.

Decisions (2026-11-12, the recommended options): role-scoped dashboards computed live from the
source tables (no warehouse yet); CSV exports with an audit record per download and small-group
suppression; outbound webhooks per organisation, signed with HMAC-SHA256 under secrets derived
from one master key, delivered and retried by the worker through the outbox. Inbound
integrations (accounting, access hardware) and a public API with keys wait for a customer need.

## 1. Exit criteria

| Criterion | Status | Evidence |
| --------- | ------ | -------- |
| Dashboards show no more than a person's own screens would | ✅ | Each area only with its read permission; sensitive incidents counted only for incident managers; counts and totals, never people (API tests, browser journey) |
| Exports are controlled and traceable | ✅ | An export permission plus the area's read permission; one `report.exported` audit record per download with size and dates; at most 366 days and 10,000 rows (API tests) |
| Aggregates do not single people out | ✅ | Occupancy by building suppressed below three units; no visitor names or resident-written text in any export (unit, API tests) |
| Exports are safe to open | ✅ | Cells starting with `= + - @` defused against formula injection (unit, API tests) |
| Webhooks are authentic and private | ✅ | HMAC-SHA256 over timestamp and body, secrets never stored, shown once; payloads without names or text; sensitive incidents never sent (worker, API tests) |
| Webhooks cannot be aimed inside | ✅ | HTTPS to named hosts only (API and database); the worker refuses private, loopback and link-local addresses, also behind a public name, and does not follow redirects (worker tests) |
| Deliveries are reliable and honest | ✅ | Outbox event per delivery in the same transaction; five attempts with backoff; outcomes only through a security-definer function (db, worker tests) |
| Tenant isolation | ✅ | RLS on both new tables; no DELETE grants; no UPDATE on deliveries (db tests) |

## 2. Product requirements (PRD 3.12)

| Requirement | Status |
| ----------- | ------ |
| Role-scoped operational dashboards | ✅ Per property |
| Finance, occupancy, maintenance, access, facilities, asset and vendor reports | ⚠️ Finance, occupancy, maintenance, visitors, facilities and incidents; assets and vendors later |
| Export controls and audit logging | ✅ |
| Scheduled reports in later phases | ⚠️ Not yet (as planned) |
| Aggregates do not leak personal information through small groups or filters | ✅ Small groups suppressed; no names or free text |

## 3. Verification at the time of review

Run locally on 2026-11-12 (Windows 11, Node 24, Bun 1.4.4; Docker not running, so the Redis tests
ran only in CI).

| Suite | Result |
| ----- | ------ |
| Lint, typecheck (18 workspaces), build (12) | ✅ |
| Unit tests | ✅ API 230, console 64, worker 19 |
| Integration, real PostgreSQL | ✅ db 299; API all but the 5 Redis tests (pass in CI) |
| Browser journeys (desktop and phone, axe WCAG 2.2 AA) | ✅ 114 of 114 with one worker |
| CI `verify` | ✅ #59-#62 green before merge |

## 4. Design review

| Area | Assessment |
| ---- | ---------- |
| Module boundaries | `reporting` reads other modules' tables through read-only SQL and owns none; `integrations` owns the webhook tables and exposes `WebhooksService.emitWithin()` for other modules' transactions (incidents and approvals use it) |
| Performance | Dashboard and export queries run per request, filtered by property; fine at pilot size, to be measured with real volumes before adding read models |
| Secrets | One master key per environment; endpoint secrets derived (HMAC) and rotated by version; nothing secret stored or logged |
| Dependencies | None added |

## 5. Open items

### Before offering webhooks to customers

- Generate a `WEBHOOK_SIGNING_KEY` per environment and give the same value to the API and the
  worker (`openssl rand -base64 32`).

### Still required before a pilot stores real data (unchanged from Phase 2)

MFA, email verification and password reset; structured JSON logging with redaction; secret
scanning in CI; console Content-Security-Policy; production database roles and tested backups;
an automated full-stack smoke test; malware scanning of uploads.

### New in Phase 12, can wait

- Organisation-wide figures across properties; trends over time; asset and vendor reports;
  scheduled reports.
- A console view of the audit log (export records included).
- Replaying failed webhook deliveries; more event types; inbound integrations and API keys.

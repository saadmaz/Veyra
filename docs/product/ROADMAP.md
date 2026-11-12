# Roadmap

Capability-based, not a promise of fixed dates. Estimate after discovery, technical spikes and
pilot access.

## Delivery stages and engineering phases

Stages are the product view; phases are the engineering increments that deliver them.

| Stage | Outcome | Engineering phases | Exit gate |
| ----- | ------- | ------------------ | --------- |
| 0. Discovery and product definition | Validated workflows, scope, pilot success criteria | 0 | Signed-off PRD, workflows, data map, risks, pilot acceptance criteria |
| 1. Engineering foundation | Secure, deployable platform skeleton | 1, 2 | Automated tests prove one organisation/property cannot access another's protected data |
| 2. Pilot MVP | First property runs selected daily workflows | 3, 4, 5, 6 (basic), 7, 10 (announcements) | Pilot users complete agreed journeys; reconciliation verified; security and recovery checks pass |
| 3. Operational depth | Facilities, parking, assets, workforce, vendors, documents, incidents | 8, 9, 10, 11 (incidents) | Release gates below |
| 4. Governance and enterprise controls | Committees, approvals, procurement, SSO, retention tooling, pen test, DR exercise | 11, 12 | Release gates below |
| 5. Global SaaS readiness | Localisation, regional adapters, data residency, subscriptions, entitlements, public API | 12, 13, 14 | Release gates below |
| 6. Intelligence and connected buildings | Permission-aware AI search, forecasting, anomaly detection, device integrations | after 14 | Release gates below |

## Engineering phases

| Phase | Deliverable                              | Status |
| ----- | ---------------------------------------- | ------ |
| 0     | Repository audit and discovery           | Architecture docs done; product discovery (Stage 0) outstanding |
| 1     | Monorepo and engineering foundation      | Done (CI green; Docker Compose verified locally 2026-11-11) |
| 2     | Identity and multi-tenancy               | Done. Exit review: [PHASE_2_REVIEW](../reviews/PHASE_2_REVIEW.md) |
| 3     | Organisation and property management     | Done. Exit review: [PHASE_3_REVIEW](../reviews/PHASE_3_REVIEW.md) |
| 4     | Resident and unit management             | Done. Exit review: [PHASE_4_REVIEW](../reviews/PHASE_4_REVIEW.md) |
| 5     | Visitor and access management            | Done. Exit review: [PHASE_5_REVIEW](../reviews/PHASE_5_REVIEW.md) |
| 6     | Finance and billing                      | Done. Exit review: [PHASE_6_REVIEW](../reviews/PHASE_6_REVIEW.md) |
| 7     | Maintenance and work orders              | Done. Exit review: [PHASE_7_REVIEW](../reviews/PHASE_7_REVIEW.md) |
| 8     | Facilities and reservations              | Done. Exit review: [PHASE_8_REVIEW](../reviews/PHASE_8_REVIEW.md) |
| 9     | Staff, vendors and assets                | Done. Exit review: [PHASE_9_REVIEW](../reviews/PHASE_9_REVIEW.md) |
| 10    | Communications and documents             | Done. Exit review: [PHASE_10_REVIEW](../reviews/PHASE_10_REVIEW.md) |
| 11    | Governance and incident management       | Done. Exit review: [PHASE_11_REVIEW](../reviews/PHASE_11_REVIEW.md) |
| 12    | Analytics and integrations               | Done. Exit review: [PHASE_12_REVIEW](../reviews/PHASE_12_REVIEW.md) |
| 13    | SaaS administration and subscriptions    | |
| 14    | Security hardening and commercial launch | |

## Stage 0 discovery still required

- Interview management, finance, security, residents, maintenance and committee members.
- Map current processes and exceptions; inventory software, devices, payment channels, documents, data.
- Confirm the data controller/owner and who may administer the platform.
- Confirm pilot property structure, unit count, roles and permission matrix.
- Validate local legal, privacy and accounting requirements.
- Prioritise MVP journeys and agree acceptance criteria (see PRD section 5).
- Wireframes tested with real users; migration, support, training and rollout approach agreed.

## Phase 1 acceptance criteria

| # | Criterion | Status |
| - | --------- | ------ |
Verified locally on 2026-11-08 (Windows 11, Bun 1.4.4, Node 26, TypeScript 7.0, Vitest 5.1).

| # | Criterion | Status |
| - | --------- | ------ |
| 1 | Bun workspaces + Turborepo with `lint`, `typecheck`, `test`, `build` | ✅ All pass across 12 workspaces |
| 2 | Strict shared TypeScript config | ✅ Typecheck clean |
| 3 | `packages/domain`: bigint `Money`, `TenantContext`, `JobEnvelope`, `DomainError` | ✅ 18 tests. Fixed: currency decimals now use ISO 4217 (PKR = 2), not `Intl` display rules |
| 4 | `packages/db`: Prisma 7 schema/config, `createDbClient`, tenant transaction helper | ✅ 5 tests; `prisma generate` and `validate` pass |
| 5 | API: env validation, `/api/v1`, helmet, CORS, request ids, error envelope, Zod pipe, health, OpenAPI | ✅ 18 tests; built API boots, live = 200, ready = 503 without a database (correct) |
| 6 | Worker: BullMQ process, tenant-enforcing job router, health endpoint | ✅ 6 tests |
| 7 | Web apps (`console-web`, `marketing-web`, `admin-web`) | ✅ 4 tests; all three `next build` successfully |
| 8 | Mobile app (`resident-mobile`, Expo SDK 58 / React Native 0.88) | ✅ 3 tests; typecheck clean. Not yet run on a device |
| 9 | Shared packages: `api-contracts`, `design-tokens`, `emails`, `web-config` | ✅ 11 tests |
| 10 | Docker Compose for PostgreSQL + Redis | ✅ Verified 2026-11-11 (Docker Desktop, Node 24): both healthy, roles bootstrapped, migrations applied as `veyra_owner`, API readiness reports database and Redis up, worker ready |
| 11 | CI workflow with isolated Postgres/Redis | ✅ Green on every PR since #4; required to merge |

## Phase 2 plan (Identity and multi-tenancy)

| Part | Scope | Status |
| ---- | ----- | ------ |
| 1-2 | Authentication decision: built-in auth behind an identity port ([ADR 0005](../adr/0005-built-in-authentication.md)) | ✅ Decided |
| 3 | Data foundation: User, PasswordCredential, Session, Organisation, Membership, Invitation, AuditLog, OutboxEvent; migration with CHECK constraints, RLS (ENABLE + FORCE), append-only audit trigger, least-privilege `veyra_app` role; tenant/user transaction helpers; embedded-PostgreSQL integration harness (24 tests) in CI | ✅ Done |
| 4 | Authentication: sign-up, sign-in, sign-out, sessions (hashed opaque token, idle + absolute expiry, revocation, transport binding), argon2id, cookie (web) / bearer (mobile), Redis rate limiting, Origin check, audit events, global deny-by-default guard ([AUTHENTICATION](../security/AUTHENTICATION.md)) | ✅ Done |
| 5 | Tenancy and authorisation: create organisation, memberships (suspend/reactivate/revoke, last-admin guard), invitations (token-hash RLS lookup), role/permission registry in code, permission guard, startup check that every route declares its access, anti-escalation, cross-tenant and expired-membership API tests ([ACCESS_CONTROL](../security/ACCESS_CONTROL.md)) | ✅ Done |
| 6 | Console UI: sign-in, sign-up, organisations list and switcher, create organisation, organisation overview with members and invitations, invitation acceptance; Playwright journeys with axe WCAG 2.2 AA checks ([ADR 0006](../adr/0006-console-calls-api-from-browser.md)) | ✅ Done |

Also in Phase 2: structured JSON logging with request ids.

## Phase 3 plan (Organisation and property management)

| Part | Scope | Status |
| ---- | ----- | ------ |
| 1 | Data foundation: properties, buildings, floors, units, common areas; composite tenant foreign keys; RLS; archive-only; unit-number rules; membership/invitation scope trigger; database tests | ✅ Done |
| 2 | Property-scoped roles (property manager) with downward-only scope inheritance; property create, list (filtered) and view; property-scoped invitations; cross-property isolation tests | ✅ Done |
| 3 | API: property settings and lifecycle (activate, archive with cascade); buildings, floors, units and common areas with archive rules, parent checks and race-safe locking | ✅ Done |
| 4 | Console: properties on the organisation page, add property, property page (overview, activate/archive, buildings, units, common areas, invite a property manager), building page (floors, units); browser journeys per role | ✅ Done |

Deferred from Phase 2 and tracked in [PHASE_2_REVIEW](../reviews/PHASE_2_REVIEW.md): MFA, email
verification, password reset, structured logging, secret scanning, console CSP, production roles
and backups, full-stack smoke test (all before a pilot stores real data).

## Phase 4 plan (Resident and unit management)

Decisions (owner, 2026-11-09): personal data limited to name, email, phone and language;
ownership shares as exact fractions; the resident mobile app comes after Phase 4.

| Part | Scope | Status |
| ---- | ----- | ------ |
| 1 | Data foundation: persons, ownerships (exact shares summing to 1, deferred check), tenancies with occupants, household members, emergency contacts, vehicles; effective dating, voiding, exclusion constraints, RLS | ✅ Done |
| 2 | Derived owner/tenant/household access (unit scope, today in the property's time zone); resident invitations linking a profile to a login; my units, unit detail, current residents | ✅ Done |
| 3 | Staff API: people (property-scoped visibility, organisation directory), set owners from a date (first owner and transfer), void, tenancies (move-in/out, void), household, vehicles, emergency contacts; archiving refused while occupied; per-unit locking | ✅ Done |
| 4 | Console: unit page with owners, tenancies, household and vehicles; property resident list; resident page with profile, records, emergency contacts and app invitation; browser journeys per role | ✅ Done |

## Phase 5 plan (Visitor and access management)

Decisions (owner, 2026-11-11):

- **Who registers visitors:** owners, tenants and household members of the unit, and staff from
  the console.
- **Visitor personal data:** name, optional phone and optional vehicle plate, with a category
  (guest, delivery, contractor, service provider). No ID numbers or photos without a separate
  legal and privacy assessment.
- **Walk-ins:** the resident approves in the app (in-app approval with expiry).
- **Gate offline:** both a documented paper procedure and an offline mode in the gate app.

Fixed by the PRD and threat model: a pass is random, time-limited, revocable and reveals no
personal data; a pass is never proof of identity; guards see the minimum necessary.

| Part | Scope | Status |
| ---- | ----- | ------ |
| 1 | Data foundation: visitor invitations, passes (hashes only), visits, append-only access events; online admission backstop (window, revocation, entries, row lock against two gates); immutable visits; RLS | ✅ Done |
| 2 | Security guard and supervisor roles; API: residents and staff create and revoke invitations, pass issue (QR token and reference code), guard validation with minimal data, check-in, check-out, denied entry, walk-in record; rate limits on pass lookups | ✅ Done |
| 3 | In-app walk-in approval: the guard requests, a resident of the unit (not staff) approves or denies within 10 minutes, the approval admits once within 15; at most 5 open requests per unit; database backstop; polling endpoints for the app and the gate | ✅ Done |
| 4 | Console: residents' visitor pages (register, pass, walk-in answers), the guard's gate screen (installable PWA), the supervisor's log; browser journeys per role | ✅ Done |
| 5 | Offline: paper procedure ([GATE_OFFLINE](../operations/GATE_OFFLINE.md)) and paper-log entry for supervisors; offline gate mode with a 4-hour hashed list, a device queue and idempotent sync; entries re-checked at the time they happened and flagged for supervisor review | ✅ Done |

## Phase 6 plan (Finance and billing)

Decisions (owner, 2026-11-11):

- **Liable party per charge type:** service charges are billed to the unit's owners; utilities
  and similar usage charges to the current tenant, or to the owners while the unit is vacant.
- **Recurring charges:** a flat amount per unit, or a rate per square metre of unit area. No
  apportionment by share ratio yet.
- **Payments:** manual (bank transfer, cash, cheque) and a payment-gateway port with signed,
  idempotent callbacks and a sandbox adapter. No real provider yet.
- **No late fees or penalties** in Phase 6: overdue status and ageing only.
- **Maker-checker** (a second person approves) only for risky actions: reversals, write-offs,
  refunds and reopening a closed period. Any finance officer or organisation admin other than
  the requester may approve (owner decision, 2026-11-12).
- **No tax lines yet**; leave room for a per-country tax adapter.
- **Allocation:** oldest invoice first; an overpayment is kept as unit credit and applied
  automatically to later invoices; finance staff can reallocate.
- **Residents** see their invoices, receipts and statement in the console and can submit a
  bank-transfer reference for finance to confirm.

The original Part 5 (all console work and the exit review) was split in two (2026-11-12): staff
screens need no API changes, while residents' access needs new permissions, a new table and a
confirmation flow, and is reviewed on its own.

Phase 6 is complete: see the [exit review](../reviews/PHASE_6_REVIEW.md).

Fixed by the PRD and data model: double-entry; posted entries are immutable and corrected only by
reversing entries; amounts are integer minor units with the currency; balances are derived from
ledger lines; callbacks are idempotent; no card data is stored.

| Part | Scope | Status |
| ---- | ----- | ------ |
| 1 | Ledger foundation: accounts per property, accounting periods, journal entries and lines; posting checks (balance, open period, active accounts, currency) with gap-free numbering; posted entries immutable for every role; mirrored reversals, at most once; property currency fixed once entries exist; RLS | ✅ Done |
| 2 | Finance roles and billing: finance officer permissions, the default chart of accounts and monthly periods per property, charge types with their liable party, recurring (flat or per sqm) and one-off charges, invoice issue posting to the ledger; API | ✅ Done |
| 3 | Payments: manual payments and receipts, oldest-first allocation, unit credit and reallocation; payment-gateway port with signed idempotent callbacks and a sandbox adapter | ✅ Done |
| 4 | Controls and reports: maker-checker for reversals, write-offs, refunds and period reopening; credit notes; statements, overdue status and ageing | ✅ Done |
| 5 | Console finance screens for staff over the existing API: set-up, charge types and recurring charges, billing runs, invoices (one-off drafts, issue, discard, credit notes), payments (record, apply, take back), maker-checker requests and decisions, ageing, statements, periods; browser journeys per role | ✅ Done |
| 6 | Residents: unit-scoped finance read permissions for owners and current tenants (their own party only), their invoices, receipts and statement in the console, and bank-transfer references submitted for finance to confirm (new table, RLS, confirm or reject); browser journeys; Phase 6 exit review | ✅ Done |

## Phase 7 plan (Maintenance and work orders)

Decisions (owner, 2026-11-11):

- **Who raises requests:** owners, tenants and household members of the unit (the same people
  who register visitors), and staff from the console, also for common areas.
- **Photos:** before/after evidence is in scope, so Phase 7 adds S3-compatible file storage
  (MinIO locally) that later modules reuse.
- **Costs:** labour, materials and other costs are recorded for reporting only; charging a
  resident for damage stays a one-off invoice raised by finance by hand.
- **Workforce and SLAs:** new Maintenance Manager and Technician roles per property; technicians
  see only work assigned to them. SLA targets per priority per property; a worker job flags
  breaches into the manager's queue. Vendors arrive in Phase 9, notifications in Phase 10.

| Part | Scope | Status |
| ---- | ----- | ------ |
| 1 | Data foundation: SLA targets, requests (unit or common area) and work orders numbered per property, validated status transitions with required reasons, resolution only when the work is done, database-owned timestamps and due times, costs corrected by voiding, append-only history written by the database, RLS | ✅ Done |
| 2 | Roles and API: Maintenance Manager and Technician; residents raise, follow, confirm or reopen their unit's requests (resident-visible history only); staff triage, accept, reject, raise and assign work orders, add notes; technicians see and progress only their own work and record costs | ✅ Done |
| 3 | File storage: S3-compatible adapter (MinIO in Docker Compose), signed upload and download URLs, type and size limits, tenant-scoped keys; photos on requests and work orders | ✅ Done (SeaweedFS instead of MinIO, whose images are no longer published; ADR 0007) |
| 4 | SLAs: targets per property in the API; a worker job marks response and resolution breaches; the manager's queue sorted by urgency and breach | ✅ Done (breaches recorded by the database, scheduled through the outbox; the worker's outbox relay is now built) |
| 5 | Console: residents' maintenance pages, the manager's queue and request page, the technician's work list; browser journeys; Phase 7 exit review | ✅ Done |

## Phase 8 plan (Facilities and reservations)

Decisions (owner, 2026-11-12, the recommended options):

- **Who books:** owners and tenants for their unit; household members only when delegated;
  staff on a resident's behalf from the console.
- **Fees and deposits:** charged to the unit's account through the Phase 6 ledger (an invoice on
  confirmation); deposits refunded by credit note. No card payment at booking.
- **Approval:** a per-facility setting: confirmed at once or waiting for a manager.
- **Time model:** fixed-length slots inside weekly opening hours, in the property's time zone.
  Waitlists stay later (PRD 3.6).

| Part | Scope | Status |
| ---- | ----- | ------ |
| 1 | Data foundation: facilities on common areas, weekly opening hours, closures, bookings in whole slots with notice/advance windows, per-unit limit and capacity checked under a per-facility lock, approval per facility, validated transitions with reasons, append-only history written by the database, RLS | ✅ Done |
| 2 | Roles and API: facility setup and closures for managers; availability in the property's time zone; residents book, list and cancel (within the cancellation window) for their unit; staff book on behalf, approve, reject, cancel and mark used or no-show | ✅ Done (household members wait for delegation) |
| 3 | Fees and deposits: per-slot fee and deposit charge types on a facility; an invoice to the unit when a booking is confirmed; deposit refunds and cancellation credits as credit notes | ✅ Done (in the booking's own transaction; paid amounts are refunded through finance) |
| 4 | Console: residents' booking pages with availability, the manager's facility setup and booking queue; browser journeys | ✅ Done |
| 5 | Phase 8 exit review | ✅ Done ([PHASE_8_REVIEW](../reviews/PHASE_8_REVIEW.md)) |

## Phase 9 plan (Staff, vendors and assets)

Decisions (2026-11-12, the recommended options; the owner asked to proceed with recommendations):

- **Vendors** belong to the organisation and can be given work orders at any of its properties;
  compliance documents are recorded with expiry dates (files can be attached later).
- **Vendor portal, quotations, purchase requests and orders** wait for a later phase (PRD 3.8
  allows phasing); vendors get no login in Phase 9.
- **Assets** belong to a property; preventive maintenance schedules raise work orders when due.
- **Staff operations**: departments, shifts with handover notes, and checklists completed by staff
  and verified by a supervisor. No attendance or leave integrations (PRD: only if legally reviewed).

| Part | Scope | Status |
| ---- | ----- | ------ |
| 1 | Vendors: register, suspension and archiving, compliance documents with expiry, work orders given to active vendors (logged), API and roles | ✅ Done |
| 2 | Assets and preventive maintenance: asset register, schedules that raise work orders, service history | ✅ Done (raised from the console; a daily worker job is a follow-up) |
| 3 | Staff operations: departments and members, shifts that never overlap for a person, started and ended by the worker with a handover note for the next shift | ✅ Done |
| 4 | Checklists and inspections: templates, runs filled in by staff with evidence notes, verification by a supervisor | ✅ Done |
| 5 | Console screens and browser journeys | ✅ Done (vendors, assets and preventive work, staff planning, my shifts and checklists) |
| 6 | Phase 9 exit review | ✅ Done ([PHASE_9_REVIEW](../reviews/PHASE_9_REVIEW.md)) |

## Phase 10 plan (Communications and documents)

Decisions (2026-11-12, the recommended options): announcements per property for everyone,
residents, one building's residents or staff, with an urgent flag and optional acknowledgement;
in-app inboxes first, then email, SMS and push through provider-neutral adapters (no real
provider yet: a logging adapter in development, as with payments); documents per property with
categories, audiences, versions and expiry dates, stored in the existing object storage.

| Part | Scope | Status |
| ---- | ----- | ------ |
| 1 | Announcements: drafts, publishing to an audience, inbox copies, reads and acknowledgements, withdrawal | ✅ Done |
| 2 | Notifications: channels (in-app, email, SMS, push) behind adapters, delivery records with status and retries through the worker, and the first events (bookings, maintenance updates) | ✅ Done (email through a logging adapter; SMS and push need phone numbers and device tokens, still to come) |
| 3 | Documents: categories, audience, versions, expiry reminders, short-lived download links | ✅ Done (expiry shown on each document; reminder notifications with the daily worker job) |
| 4 | Console screens and browser journeys | ✅ Done (inbox and notifications, announcements with delivery status, documents for staff and residents) |
| 5 | Phase 10 exit review | ✅ Done ([PHASE_10_REVIEW](../reviews/PHASE_10_REVIEW.md)) |

## Phase 11 plan (Governance and incident management)

Decisions (2026-11-12, the recommended options): incidents per property reported by staff, with
severity, an append-only timeline, follow-up actions that must be done before closing, sensitive
records for managers only and escalation contacts per kind of incident; high and critical reports
alert the managers in-app and by email. VEYRA does not replace emergency services. Governance
follows: committees and terms, meetings with agendas, minutes and resolutions, and approval
policies with thresholds. Voting waits for legal review (PRD 3.11).

| Part | Scope | Status |
| ---- | ----- | ------ |
| 1 | Incidents: reports, timeline, follow-up actions, sensitive records, escalation contacts, manager alerts | ✅ Done |
| 2 | Committees and meetings: members and terms, meetings, agendas, minutes, resolutions with supporting documents | ✅ Done (a Committee member role; managers keep the records; no voting in the application) |
| 3 | Approval policies: thresholds and approvers for expenses, purchases and other requests | ✅ Done (managers or a committee's current members; finance's maker-checker approvals stay as they are) |
| 4 | Console screens and browser journeys | ✅ Done (incidents with timeline, follow-ups and contacts; committees, meetings, minutes and resolutions; approvals and policies) |
| 5 | Phase 11 exit review | ✅ Done ([PHASE_11_REVIEW](../reviews/PHASE_11_REVIEW.md)) |

## Phase 12 plan (Analytics and integrations)

Decisions (2026-11-12, the recommended options): role-scoped dashboards computed live from the
source tables (no separate warehouse yet); CSV exports with an audit record per export and
small-group suppression for anything about people; outbound webhooks per organisation, signed
with HMAC-SHA256, delivered and retried by the worker through the outbox, with a delivery log.
Inbound integrations (accounting, access hardware) and a public API with keys wait for a
customer need (Phase 13/14).

| Part | Scope | Status |
| ---- | ----- | ------ |
| 1 | Dashboards: a property's figures by area (occupancy, finance, maintenance, visitors, facilities, incidents, approvals), each only for people who can see that area | ✅ Done |
| 2 | Exports: CSV reports per area with export permissions, an audit record per export and small-group suppression | ✅ Done (occupancy by building, arrears, maintenance requests, visits, incidents) |
| 3 | Webhooks: endpoints per organisation, event subscriptions, signed deliveries retried by the worker, delivery log | ✅ Done (incident and approval events; secrets derived from one master key, never stored) |
| 4 | Console screens and browser journeys | ✅ Done (figures and exports on the property page, webhooks for organisation admins) |
| 5 | Phase 12 exit review | ✅ Done ([PHASE_12_REVIEW](../reviews/PHASE_12_REVIEW.md)) |

## Phase 13 plan (SaaS administration and subscriptions)

Decisions (2026-11-12, the recommended options): three plans (Starter, Professional, Enterprise)
kept in the database with their features and property and unit limits; every permission belongs
to a feature; existing organisations move to Enterprise (no change), new ones start a 30-day
Enterprise trial; a cancelled subscription or an ended trial leaves the organisation read-only;
payment overdue keeps working (grace). No billing provider yet: plan changes are made by
platform administrators. Platform administrators see no tenant data; support access is
time-boxed, reason-logged, approved by the organisation and visible to it.

| Part | Scope | Status |
| ---- | ----- | ------ |
| 1 | Plans, subscriptions and entitlements: features per plan enforced on every request, limits enforced by the database, read-only when lapsed, history | ✅ Done |
| 2 | Platform administration: platform admins, organisation list without tenant data, plan and status changes, suspension, all audited | ✅ Done ([runbook](../operations/PLATFORM_ADMIN.md)) |
| 3 | Support access: requested with a reason, approved by an organisation admin, time-boxed, read-only, visible and revocable | ✅ Done |
| 4 | Console screens and browser journeys | |
| 5 | Phase 13 exit review | |

## Release gates

No stage is complete on a feature demo alone. Each release requires: acceptance criteria met,
tests passing, security and permission review, migration and rollback plan, monitoring and
alerting, backup and restore validation appropriate to risk, documentation and support
readiness, user training and release communication, and known limitations documented.

## Technical debt

- Finance: invoice lists return the 200 most recent matching the filters (no paging yet);
  creating a one-off invoice is not idempotent (no `Idempotency-Key` yet; payments in Part 3
  will need it); the chart of accounts has no add, rename or archive endpoints yet (archiving must
  refuse accounts with a balance); billing runs process a whole property in one transaction
  (move to a worker job if properties grow to thousands of units); MFA is not yet required for
  finance actions (ACCESS_CONTROL rule 7).
- Payments: payment intents past their expiry are not marked EXPIRED yet (needs a worker job; a
  late success is still recorded, since the money has moved); an AMOUNT_MISMATCH callback leaves
  the intent pending with no screen to resolve it yet; payment lists return the 200 most recent;
  payments cannot be reversed or refunded until Part 4; no real payment provider adapter yet
  (owner decision); callbacks are not rate-limited (they are signature-checked first).
- Controls: statements cover a party's whole history (no date range or opening balance yet);
  ageing is computed from what is outstanding now, so an `asOf` date in the past does not
  reconstruct what was owed then; approvals list the 200 most recent; no notification tells an
  approver that a request is waiting (notifications module); refunds go to the payment's unit
  credit only (no refund of a deposit or of an overpayment across parties).
- Finance console: a one-off invoice is created with one line (the API accepts several); there
  is no screen yet for online payment intents or for resolving an `AMOUNT_MISMATCH` callback; the
  invoice and payment lists show the API's 200 most recent with no paging; the chart of accounts
  is read-only (no API to add or rename accounts yet).
- Maintenance console: request and work order lists show the 200 most recent (the queue 500)
  with no paging; voiding a cost asks for the reason with the browser's prompt; the property's
  member screens cannot yet invite Maintenance Managers or Technicians (use the API).
- Outbox and SLAs: published outbox rows are kept (no retention job yet); the relay polls every
  15 seconds, so a breach is recorded up to that long (plus queue time) after it happens; there is
  no end-to-end test of worker, Redis and database together (each part is tested); breaches are
  not yet sent to anyone (notifications, Phase 10).
- File storage (ADR 0007): uploads never completed leave PENDING attachments (and maybe objects)
  until a worker job and a bucket lifecycle rule clean them up; a failed delete after removal
  leaves an orphaned object; no malware scanning yet; production buckets need CORS for the
  console's origin.
- Residents' finance: access ends with the ownership or tenancy record, so former owners and
  tenants cannot read their past account; no bank-slip attachment (file storage) and no way to
  withdraw a submission (finance rejects it instead); residents are not notified when a
  transfer is confirmed or rejected (notifications module); lists show the 200 most recent;
  no online payment from the resident console until a real provider exists.
- Resident console: the people picker (`GET …/properties/:id/persons`) returns at most 200
  people and the console does not use its `query` filter yet; add type-ahead search when a
  property has more.
- Resident console: no UI for vehicles linked to a person (not a unit), archived vehicles,
  archiving a resident profile, or the full ownership/tenancy history of archived units' numbers
  (shown as "Archived unit"). The resident list has no paging or search (the API returns all
  current residents).
- QR scanning relies on the browser's `BarcodeDetector` (Chromium); Safari and Firefox fall back
  to typing the reference code.
- Offline gate mode works when the connection drops while the gate screen is open. Opening the
  screen with no connection needs a service worker caching the app shell (not built); until
  then the paper procedure applies ([GATE_OFFLINE](../operations/GATE_OFFLINE.md)).
- Walk-in requests reach residents by polling only. Instant delivery (WebSockets, then push
  notifications through the notifications module) is still to come; until then a resident must
  have the app open to answer within the 10 minutes.
- Void reasons use the browser's native prompt (accessible, but plain); replace with the design
  system's dialog when one exists.
- Mobile app not yet launched on a device or emulator.
- `bunfig.toml` uses the hoisted linker for React Native; revisit if Bun's isolated linker gains Metro support.
- Structured logging (pino + OpenTelemetry) not yet added; Nest's default logger is in use.
- General per-user API rate limiting not yet enabled (authentication limits are).
- Built-in auth lacks MFA, email verification, password reset and breached-password checks
  (ADR 0005); required before privileged customer users go live.
- CI still starts a PostgreSQL service container that no test uses (integration tests use
  embedded-postgres). The Redis service container is now used by the rate-limiter tests.
- Authentication gaps listed in [AUTHENTICATION section 8](../security/AUTHENTICATION.md):
  sign-up email enumeration, no sign-out-everywhere, rate-limited attempts not audited.
- Console: no editing forms yet for property settings or individual buildings, floors, units
  and common areas (create and archive only); unit lists load up to 200 rows without paging.
- Units cannot move between buildings yet; optional address fields cannot be cleared once set.
- Restoring an archived property or structure is not supported (archive is final for now).
- No expired-session cleanup job yet (rows stay until a worker job prunes them).
- Production database role provisioning (veyra_owner / veyra_app from a secrets manager) not yet
  scripted.
- `dev` scripts for api/worker build once and run; no watch mode yet.
- Module-boundary lint check to be added when the second business module exists.
- Worker `main.ts` (Redis wiring, health server) has no automated test; covered by the Phase 2 integration harness.
- Invitation emails are not sent yet: the API returns the one-time token to the inviter, who
  shares the link. Sending moves to the notifications module (`@veyra/emails` has the template).
- Invitations are bound to an email address, but sign-up does not verify email ownership yet
  (ADR 0005 gap), so a token leaked to someone who registers that address could be accepted.
- Membership and invitation lists use keyset pagination; no filters or search yet.
- Effective permissions are read from the database on every request (no cache). Add the
  Redis cache with invalidation events only when measurements require it.
- No module-boundary lint rule yet: modules import each other only through their `index.ts`
  by convention.
- No Content-Security-Policy yet on the web apps (added per app once script/style sources are known).
  The console now knows its sources (self + the API origin); add its CSP next.
- Console: no membership actions (suspend/revoke) or organisation settings form in the UI yet
  (the API supports both); no localisation framework yet (error texts are centralised in
  `src/lib/messages.ts`); browser tests use a fake API, so an automated full-stack smoke test
  (console + API + database + Redis) is still missing. The Phase 4 console's requests were
  checked once by hand against the real API (2026-11-11).
- Dependency and secret scanning not yet in CI.

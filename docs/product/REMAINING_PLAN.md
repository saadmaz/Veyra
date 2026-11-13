# Remaining work: Phase 16 onwards

- **Date:** 2026-11-13
- **Starting point:** Phases 0–15 are done (see [ROADMAP](ROADMAP.md) and `docs/reviews/`).
- **What this covers:** every item still open. That includes:
  - the open items of each phase review;
  - the technical-debt list;
  - the [launch checklist](../operations/LAUNCH_CHECKLIST.md);
  - the parts of the AGENTS.md product brief that are not built yet: parking, budgets and
    expenses, procurement, realtime, localisation, SSO, tenant export and deletion, the public
    API, AI and hardware.

Phases are ordered by what blocks real customers first. Each phase still needs acceptance
criteria, tests, docs and an exit review before the next one starts (AGENTS.md section 16).

Who does what is marked on each item:
- **[Owner]** a decision or account only the product owner can provide;
- **[Ops]** an action by whoever runs the environment;
- unmarked items are engineering.

## Summary

| Phase | Theme | Blocks |
| ----- | ----- | ------ |
| 16 | Discovery and pilot definition | Knowing what the first customer actually needs |
| 17 | Production environment and observability | Anyone using VEYRA outside a laptop, including the mobile apps |
| 18 | Messaging: email, push, SMS, realtime | Invitations, password reset and notifications reaching people |
| 19 | Payments and subscription billing | Collecting money: residents' dues and VEYRA's own fees |
| 20 | Security, privacy and compliance | Significant commercial deployment (pen test, export and deletion, SSO) |
| 21 | Mobile apps in the stores | Residents and staff installing from Google Play and the App Store |
| 22 | Console completeness and localisation | Daily use at scale (paging, editing, other languages) |
| 23 | Finance depth: expenses, budgets, procurement | Full accounting for a community, not only receivables |
| 24 | Parking management | Product module 17 |
| 25 | Operations depth | The deferred features of Phases 5–11 |
| 26 | Analytics, public API and integrations | Enterprise customers and connected systems |
| 27 | Intelligence (AI) | Stage 6 of the roadmap |
| 28 | Global scale | Many markets, regions and large customers |

Phases 16 and 17 can run in parallel. Phases 18 and 19 need 17. Phase 21 needs 18 (push) and
should follow 19 (payments in the app).

---

## Phase 16: Discovery and pilot definition

The only stage the original roadmap marks as still outstanding (Stage 0).

1. **[Owner]** Choose the pilot customer and property. Confirm its buildings, unit count, roles
   and permission matrix.
2. **[Owner]** Interview the people who will use it: management, finance, security, residents,
   maintenance, the committee.
3. **[Owner]** Map their current processes and exceptions. Inventory their current software,
   gate devices, payment channels, documents and data.
4. **[Owner]** Confirm the data controller and who may administer the platform.
5. **[Owner]** Validate local legal, privacy and accounting requirements for the pilot's
   country.
6. Turn the findings into pilot acceptance criteria. Update the PRD and the permission matrix.
7. Plan data migration from the customer's current records: units, owners, tenants, balances.
   Build an import tool for units and residents if the pilot needs one.
8. Agree the support, training and rollout approach. Write a short user guide per role.

**Exit:** a signed-off pilot scope with acceptance criteria and a migration plan.

## Phase 17: Production environment and observability

1. **[Owner]** Choose the hosting provider and the region. Buy the domain.
2. **[Ops]** Managed services:
   - PostgreSQL with point-in-time recovery;
   - Redis;
   - an S3-compatible bucket with versioning, a lifecycle rule and CORS for the console's origin;
   - ClamAV.
3. **[Ops]** Secrets manager with keys and passwords generated per environment
   (`production-roles.sql`, `MFA_ENCRYPTION_KEY`, `WEBHOOK_SIGNING_KEY`).
4. Continuous deployment from `main`:
   - build the image;
   - take a backup point;
   - migrate as the owner;
   - roll out worker, then API, then console;
   - run the smoke test against the environment;
   - roll back by image.
5. Add the admin tool and the marketing site to the image and the deployment.
6. Staging environment (or production plus preview) and TLS everywhere.
7. Observability:
   - OpenTelemetry traces;
   - Sentry for the API, worker, console and mobile apps;
   - JSON logs from the worker, as from the API;
   - alerts on readiness, error rates, queue backlog and failed jobs.
8. Housekeeping worker jobs:
   - prune expired sessions;
   - clean up uploads that were never completed, and their objects;
   - delete published outbox rows after a retention period;
   - mark expired payment intents;
   - mark past confirmed bookings as used.
9. A general per-user API rate limit (only authentication is limited today). Rate-limit payment
   callbacks.
10. A slimmer image (production dependencies only, per-app layers).
11. Developer experience:
    - watch mode for the `dev` scripts of the API and worker;
    - remove the unused PostgreSQL service from CI;
    - a test of the worker main process with Redis and the database together.
12. **[Ops]** First timed restore drill in staging; the drill then runs monthly.
13. Point the mobile app builds at the deployed API: the Android APKs workflow input, then EAS
    profiles.

**Exit:** the pilot environment is live and monitored, and the smoke test and restore drill pass
against it.

## Phase 18: Messaging (email, push, SMS, realtime)

1. **[Owner]** Choose the email provider and sending domain (suggested: Postmark or Resend).
   Decide whether SMS is wanted and with which provider.
2. Email adapter behind the notifications port, with SPF, DKIM and DMARC on the sending domain.
3. Send what is written to the log today:
   - verification emails;
   - password-reset emails;
   - welcome emails;
   - invitation emails (today the inviter copies the link).
4. Push notifications:
   - Expo push service;
   - device token registration and removal on sign-out;
   - per-app routing (resident or staff);
   - opening the right screen from a notification.
5. Realtime: a WebSocket gateway so the console and apps get walk-in requests, gate events and
   inbox items instantly instead of by polling.
6. SMS adapter (if wanted) for urgent announcements and walk-in requests to residents without
   the app.
7. Notifications that are missing today:
   - an approval or finance request waiting;
   - a transfer confirmed or rejected;
   - booking decisions and closures;
   - maintenance updates to residents;
   - SLA breaches to managers;
   - support access requests to organisation admins;
   - a trial ending.
8. Notification preferences per person and channel. Message templates. Scheduled
   announcements. Unit- and role-level audiences.
9. A daily worker job for document and vendor-document expiry reminders.
10. A notification badge in the console navigation.
11. Delivery tracking and retries per channel. A failed notification never blocks the action
    that caused it (AGENTS.md critical scenario).

**Exit:** a resident invited from the console receives the email, signs up, and gets push
notifications for walk-ins and announcements.

## Phase 19: Payments and subscription billing

**Residents' dues**

1. **[Owner]** Choose the payment provider or providers for the pilot's market.
2. A real payment gateway adapter beside the sandbox, with signature-checked callbacks,
   idempotency and reconciliation.
3. Online payment from the resident console and the resident app.
4. Payment handling:
   - a screen to resolve `AMOUNT_MISMATCH` callbacks;
   - refunds, including deposits and overpayments across parties;
   - reversals.
5. Bank statement import and matching, to confirm transfers in bulk.
6. Bank transfers from residents: attach the bank slip, and withdraw a submission.
7. Former owners and tenants keep read access to their past account.

**Finance operations**

8. An idempotent one-off invoice (`Idempotency-Key`), with several lines in the console.
9. Chart of accounts: add, rename and archive accounts (refusing accounts with a balance).
10. Billing runs as worker jobs for large properties.
11. Statements with a date range and opening balance. Ageing as of a past date.
12. Tax adapters per market.
13. **[Owner]** Review of the accounting policy by a qualified accountant before claiming
    statutory accounting support.

**VEYRA's own billing**

14. **[Owner]** Choose the billing provider. Decide on self-serve upgrades, trial length and
    reminders.
15. Subscription billing:
    - checkout and self-serve plan changes;
    - invoices and receipts;
    - dunning (payment overdue, then read-only);
    - trial reminders.
16. Plan editing in the admin tool (plans change by migration today).

**Exit:** a resident pays an invoice online and the ledger reconciles. A customer subscribes and
pays without a platform administrator stepping in.

## Phase 20: Security, privacy and compliance

1. **[Owner]** An independent penetration test. Fix the findings, or accept them in writing.
2. Passkeys (WebAuthn) beside TOTP. A breached-password check at sign-up and on password change.
3. Authentication gaps:
   - sign-out everywhere;
   - audit rate-limited attempts;
   - close sign-up email enumeration;
   - **[Owner]** decide whether unconfirmed email addresses may accept invitations.
4. CSP nonces instead of inline scripts in the console and admin tool.
5. Enterprise single sign-on (OIDC, then SAML) behind the identity port, per organisation.
6. Tenant data export: a complete, machine-readable export of an organisation (AGENTS.md
   critical scenario).
7. Tenant deletion and a closure procedure: staged deletion, legal holds, and keeping only what
   law requires (finance records, audit).
8. Data subject requests for individuals: access, correction, erasure where the law allows.
9. Retention rules per record type, enforced by worker jobs, per jurisdiction:
   - visit records and gate logs;
   - documents;
   - audit;
   - finance.
10. Support access: audit every read made during a support session. Show it to the
    organisation.
11. A console view of the audit log, filterable, with export records included.
12. **[Owner]** Terms of service, privacy notice and data processing agreement for each market.
    No certification claims without the formal work.
13. Security review of the mobile apps: certificate pinning (or a documented decision against
    it), jailbreak/root policy, screenshot protection on pass screens.
14. Engineering guard rails:
    - a module-boundary lint rule;
    - a permission cache with invalidation only if measurements require it;
    - an incident response runbook.

**Exit:** pen test findings closed, export and deletion tested end to end, legal documents
published.

## Phase 21: Mobile apps in the stores

1. **[Owner]** Google Play developer account, Apple Developer Program, and an EAS project.
2. EAS build profiles (development, preview, production) with managed signing keys and an
   `https://` API per environment.
3. iOS builds; TestFlight and Play internal testing tracks.
4. Device journeys (Maestro) in CI:
   - sign-in, including two-step sign-in;
   - a visitor pass from creation to gate admission;
   - the offline gate and its sync;
   - a maintenance request;
   - a booking.
5. Photo upload on maintenance requests and work orders (image picker, using the shared
   `uploadFile`).
6. Push notifications (from Phase 18) and online payments (from Phase 19) in the apps.
7. Password reset, email confirmation and invitation acceptance inside the apps, with deep
   links.
8. Kiosk mode for dedicated gate phones (screen pinning, sign-out at the end of a shift), if the
   owner wants it.
9. Align the workspace on one React version. Move the copied UI building blocks into a shared
   mobile package.
10. Over-the-air updates (EAS Update) with a release policy. A minimum supported version check.
11. Store listings, screenshots, privacy labels and data-safety forms.
12. An accessibility pass with TalkBack and VoiceOver on real devices.

**Exit:** both apps published in both stores; device journeys pass in CI.

## Phase 22: Console completeness and localisation

1. Paging and search on every list now capped at 200:
   - invoices, payments, approvals and transfers;
   - maintenance requests and work orders;
   - residents and units;
   - the people picker (type-ahead using the API's `query`).
2. Editing forms:
   - property settings;
   - individual buildings, floors, units and common areas;
   - clearing optional address fields.
3. Restoring archived properties and structure. Moving units between buildings.
4. Organisation settings form. Membership actions (suspend, reactivate, revoke). Inviting
   Maintenance Managers and Technicians from the property's member screens.
5. A design-system dialog replacing the browser's prompt for void reasons and confirmations.
6. Residents:
   - vehicles linked to a person;
   - archived vehicles;
   - archiving a profile;
   - full history of archived units;
   - resident suspension, distinct from ending a record.
7. Facilities: different opening hours per day in the forms. Editing checklist templates and
   vendor details.
8. Governance:
   - renaming and dissolving committees;
   - editing escalation contacts;
   - choosing a unit or common area when reporting an incident.
9. The offline gate opens without a connection (a service worker caching the gate screen). QR
   scanning in Safari and Firefox (a scanning library).
10. Localisation framework for the web and mobile apps:
    - all text moved to message catalogues;
    - number, date and currency formats per locale;
    - right-to-left support;
    - **[Owner]** the first languages to translate.
11. Property locale, branding (logo, colours) and operational rules.
12. Browser journeys for the admin tool. An accessibility audit with real users.
13. Prune the technical-debt list in the roadmap: several entries are now done (MFA, logging,
    CSP, smoke test, secret scanning, production roles).

**Exit:** no list is capped, every record that can be created can be edited, and the console
ships in at least two languages.

## Phase 23: Finance depth (expenses, budgets, procurement)

Product module 4 (expenses, budgets, income and expenditure) and module 8 (vendor and
procurement management).

1. Expenses:
   - recording supplier invoices against expense accounts;
   - approval before posting;
   - payment to vendors;
   - attachments.
2. Budgets per property and year, by account. Budget against actual.
3. Income and expenditure reports, a balance sheet, and period close on accounting periods.
4. Procurement:
   - purchase requests;
   - quotations from vendors;
   - purchase orders;
   - goods and service received;
   - three-way matching with the vendor invoice.
5. Approval workflows raising expense and purchase records (the governance approvals module).
6. Vendor portal: vendors see their assigned work, submit quotations and invoices, and keep
   their documents up to date.
7. Vendor performance from work orders, ratings and on-time completion.
8. Retaining a booking deposit for damage as a booking action (a manual journal today).
9. Accounting platform export (adapters in Phase 26).

**Exit:** a property can run its full accounts in VEYRA (receivables, payables, budget) and an
accountant can close a month.

## Phase 24: Parking management

Product module 17. Today parking exists only as a common-area type.

1. Parking inventory: zones, levels and bays, with type (resident, visitor, accessible, EV) and
   status.
2. Allocation of bays to units (owned or rented) with effective dates, and charges through
   recurring charges.
3. Vehicles linked to bays and permits. Permit expiry.
4. Visitor parking: a bay or time limit on visitor passes. Overstay records at the gate.
5. Gate vehicle entry and exit, linked to visits and resident vehicles.
6. Violations and incidents (from the incidents module).
7. Screens in the console, the resident app (my bays, visitor parking) and the staff app (plate
   lookup).

**Exit:** a property allocates and charges for parking, and guards check plates at the gate.

## Phase 25: Operations depth

Deferred items from Phases 5–11.

1. Visitors:
   - incident escalation from a gate denial;
   - retention periods for visit records and paper logs (with Phase 20).
2. Maintenance:
   - preventive maintenance raised by a daily worker job;
   - photos on checklists and vendor documents.
3. Facilities:
   - waitlists;
   - a per-user limit beside the per-unit limit;
   - household delegation, so household members may book.
4. Workforce:
   - per-department supervisors;
   - recurring checklists;
   - attendance integration (time clocks).
5. Incidents:
   - photos and files;
   - playbooks per kind of incident;
   - residents reporting incidents from their app.
6. Governance:
   - meeting attendance and quorum;
   - committee members drafting minutes;
   - publishing approved minutes to residents;
   - escalation or expiry of approval requests left pending.
7. Residents and access:
   - building- and unit-scoped roles;
   - property managers inviting others to their own property.
8. An emergency procedures module: emergency contacts board, evacuation broadcasts, roll call.

**Exit:** each item has an owner-approved scope and ships with tests; none blocks the pilot.

## Phase 26: Analytics, public API and integrations

1. Organisation-wide figures across properties, trends over time, and asset, vendor and parking
   reports.
2. Scheduled reports delivered by email (needs Phase 18).
3. Webhooks:
   - replaying failed deliveries;
   - more event types;
   - a delivery log screen.
4. Public API:
   - API keys or OAuth clients per organisation, with scopes;
   - per-key rate limits;
   - versioned documentation;
   - a developer portal page.
5. Inbound integrations: importing residents, units and balances from other systems.
6. Accounting platform adapters (for example Xero or QuickBooks, by market).
7. Access-control hardware adapters: barrier gates, door controllers, ANPR cameras, with the
   offline rules unchanged (stale permissions never grant entry).
8. Maps and geolocation where a feature needs them (multi-site organisations).

**Exit:** an enterprise customer connects its own systems through documented, scoped APIs.

## Phase 27: Intelligence (AI)

AGENTS.md section 11. AI is optional and never approves payments, grants access or changes
ownership.

1. **[Owner]** Choose the model provider, decide the data processing terms, and decide which
   features are wanted first.
2. Permission-aware document search in natural language, which only searches what the person may
   read.
3. Maintenance request classification and priority suggestions; staff confirm them.
4. A resident support assistant that answers from the property's documents and announcements,
   and hands over to staff.
5. Report and notification summaries for managers.
6. Anomaly detection in finance (unusual payments, duplicates) and gate activity, raised as
   reviews for people to look at.
7. Maintenance forecasting from asset history. Financial trend analysis.
8. Evaluation sets, cost limits per organisation, an opt-out per organisation, and audit of AI
   use.

**Exit:** each AI feature passes its evaluation, respects tenant and resource permissions, and
can be turned off per organisation.

## Phase 28: Global scale

1. Data residency: regions per organisation, routing, and backups kept in-region.
2. Load and soak testing:
   - billing runs;
   - gate traffic;
   - notification fan-out;
   - exports.
3. Performance budgets per endpoint and screen.
4. Read replicas where reports need them. Worker and API scaled independently.
5. Regional adapters: taxes, payment methods, address formats, regulatory reports per market.
6. A disaster recovery exercise across regions, with RPO and RTO measured against the targets.
7. Cost monitoring per tenant, with plan limits tuned to usage.
8. **[Owner]** Formal compliance work if the market requires it (for example ISO 27001 or
   SOC 2), only then claimed.

**Exit:** VEYRA runs in more than one region with tested recovery, and large customers stay
within their performance budgets.

---

## Owner decisions in one list

| Decision | Needed by |
| -------- | --------- |
| Pilot customer, property and scope | Phase 16 |
| Hosting provider, region and domain | Phase 17 |
| Email provider and sending domain; SMS yes or no | Phase 18 |
| Payment provider for residents' dues | Phase 19 |
| Billing provider, self-serve upgrades, trial length and reminders | Phase 19 |
| Accountant review of the accounting policy | Phase 19 |
| Pen test vendor; legal documents per market | Phase 20 |
| Whether unconfirmed email addresses may accept invitations | Phase 20 |
| Google Play and Apple developer accounts; kiosk mode for gate phones | Phase 21 |
| First languages to translate | Phase 22 |
| AI provider and the first AI features | Phase 27 |
| Formal certifications | Phase 28 |

# VEYRA — Master Product Engineering Instructions

> Primary implementation brief for any AI coding agent working in this repository.
> Read this file and the relevant `docs/` before making changes.

## 1. Role and responsibilities

You are the Chief Technology Officer, Principal Software Architect, Staff Software Engineer,
Product Engineering Lead and Security Engineering Lead for VEYRA.

You are responsible for architecting, developing, reviewing, testing, documenting and
maintaining VEYRA as a commercial, enterprise-grade global SaaS product.

Every implementation decision must consider: scalability, security, multi-tenancy,
maintainability, performance, reliability, data integrity, user experience, global
expansion, operational cost and long-term technical sustainability.

This is not a prototype or a university project. It is a production-oriented platform
that will serve real residential communities, property management companies,
condominium corporations and enterprise customers.

## 2. Product vision

- **Product:** VEYRA
- **Tagline:** Intelligent Living. Unified Operations.
- **Category:** Property Technology / Community Management SaaS

VEYRA is a digital operating platform that centralises and automates the management of
residential communities, condominiums, apartment complexes, gated communities and
property management organisations.

Property administrators, management committees, residents, owners, tenants, security
personnel, maintenance teams, finance officers and external vendors interact with the
system according to their assigned responsibilities and permissions.

VEYRA is a configurable, multi-tenant SaaS platform serving customers in multiple
countries, supporting both single properties and organisations managing many properties.

## 3. Technology stack

Audit existing repository decisions before introducing or replacing technologies.

| Component          | Technology                          |
| ------------------ | ----------------------------------- |
| Web frontend       | Next.js + React                     |
| Language           | TypeScript                          |
| Mobile application | Flutter                             |
| Backend            | NestJS                              |
| Database           | PostgreSQL                          |
| ORM                | Prisma                              |
| Cache              | Redis                               |
| Background jobs    | BullMQ                              |
| API                | REST + OpenAPI                      |
| Authentication     | OIDC-compatible provider            |
| Storage            | S3-compatible storage               |
| Realtime           | WebSockets                          |
| Monorepo           | Bun + Turborepo                     |
| Testing            | Vitest/Jest + Playwright            |
| Infrastructure     | Docker + Cloudflare + cloud hosting |
| Monitoring         | OpenTelemetry + Sentry              |

### Architecture rules

- Use a **modular monolith**. Do not start with microservices.
- Each business module owns its domain logic, application services, persistence
  interfaces and presentation layer.
- No circular dependencies. Modules communicate through explicit application
  interfaces and domain events.
- API and background worker processes must scale independently.
- PostgreSQL is the source of truth. Redis is for caching and job coordination only —
  never the authoritative store for financial or access-control data.
- Design modules so they can be extracted into services later, only when there is a
  genuine business or technical need.

## 4. Product modules

These are product capabilities, **not** a mandate to implement everything in the first release.

1. **Organisation & Property Management** — onboarding, multiple properties per
   organisation, buildings/towers/blocks, floors and units, unit categories, common
   areas, property settings, branding, operational policies, lifecycle and archival.
2. **Resident & Occupant Management** — invitations, owner/tenant profiles, household
   members, multiple unit relationships, ownership records with effective dates,
   tenancy periods, verification, move-in/move-out, vehicles, emergency contacts,
   status and access revocation, privacy-controlled directory.
3. **Visitor & Access Management** — pre-registration, QR passes, temporary access,
   check-in/out, guard dashboard, deliveries and contractors, vehicle entry/exit,
   access history, denied-entry records, emergency procedures, hardware integrations,
   time-limited and revocable passes.
4. **Finance & Accounting** — recurring fees, invoices, utility charges, payment
   tracking, online payments, bank transfers, reconciliation, receipts and statements,
   credit notes, late charges, expenses, budgets, income/expenditure reporting,
   approval workflows, immutable posted ledger entries with reversals.
5. **Maintenance & Service Management** — requests, complaints, work orders,
   technician scheduling, priorities, SLAs, progress tracking, before/after evidence,
   cost tracking, resident feedback, escalation, history.
6. **Facilities & Reservations** — pools, gyms, clubhouses, function rooms, sports
   facilities, availability, calendar, fees and deposits, cancellation policies,
   approvals, usage restrictions, maintenance closures.
7. **Staff & Workforce Management** — profiles, departments, shifts, attendance
   integration, daily tasks, checklists, inspections, handover reports, supervisor
   verification.
8. **Vendor & Procurement Management** — registration, verification, service
   agreements, contracts, document expiry reminders, quotations, purchase requests and
   orders, vendor performance, invoice matching.
9. **Communications & Notifications** — announcements, targeted messaging, emergency
   broadcasts, push/email/SMS/in-app, delivery tracking, read acknowledgements,
   templates, document distribution.
10. **Analytics & Reporting** — property overview, occupancy, financial, outstanding
    payments, visitor, maintenance, staff, facility and vendor reports; exports and
    scheduled reporting.
11. Asset management and preventive maintenance.
12. Incident and emergency management.
13. Committee and governance management.
14. Meeting management and resolutions.
15. Document management and digital records.
16. Approval workflows.
17. Parking management.
18. Integrations and external APIs.
19. Platform administration.
20. SaaS subscriptions, entitlements and usage management.

## 5. Multi-tenancy

```
VEYRA PLATFORM
├── Organisation A
│   ├── Property A1
│   │   ├── Building A
│   │   │   ├── Floor 01
│   │   │   ├── Floor 02
│   │   │   └── Units
│   │   └── Building B
│   └── Property A2
├── Organisation B
│   └── Property B1
└── Organisation C
    ├── Property C1
    └── Property C2
```

Implement:

- Strict tenant isolation.
- Organisation-level and property-level permissions.
- Users with multiple memberships and multiple roles.
- Unit-specific and temporary access.
- Tenant lifecycle management.
- Subscription and feature entitlements.
- Tenant-specific configuration.
- Secure customer onboarding.
- Tenant-aware background jobs, reporting and exports.

**Never rely solely on frontend permissions. Every protected API operation must
independently verify the caller's authority.**

## 6. Permissions and access control

Implement RBAC + resource-scope authorisation.

| Role                 | Access                                |
| -------------------- | ------------------------------------- |
| Platform Super Admin | Platform-level operations             |
| Organisation Admin   | Organisation configuration            |
| Property Manager     | Assigned property operations          |
| Committee Member     | Governance and assigned approvals     |
| Finance Officer      | Financial operations                  |
| Security Supervisor  | Security management                   |
| Security Guard       | Visitor and access processing         |
| Maintenance Manager  | Maintenance operations                |
| Technician           | Assigned work orders                  |
| Owner                | Authorised unit and resident services |
| Tenant               | Active tenancy services               |
| Household Member     | Delegated resident services           |
| Vendor               | Assigned external work                |

The permission engine must answer: who can perform an action, on which organisation,
property, building/unit and resource, during what period, and under which approval
conditions.

Include tests for privilege escalation, expired memberships and cross-property access.

## 7. Database and data integrity

- PostgreSQL is the source of truth, with a properly normalised schema.
- Foreign keys, tenant-aware constraints, indexes, safe migrations, transactions,
  audit records, explicit relationships and validated state transitions.
- UTC timestamps; property-specific IANA time zones.
- **Never use JavaScript floating-point numbers for money.** Store currency with every
  monetary value.
- Financial transactions must be traceable. Posted ledger entries are never silently
  edited or deleted — use reversals and correction entries.

## 8. Frontend and design system

VEYRA must feel like a premium international enterprise SaaS product: sophisticated,
minimal, professional, clear information architecture, excellent typography,
consistent spacing, thoughtful data visualisation, fast and responsive.

Central design system: colour tokens, typography, spacing, buttons, forms, tables,
modals, drawers, navigation, status indicators, charts, notifications, and empty,
loading and error states.

Build distinct experiences for administrators, residents and frontline operations.
Do not force every user into the same dashboard.

## 9. Mobile applications

**Resident app:** secure login, profile, unit information, visitor registration, QR
passes, maintenance requests, facility bookings, invoices and payment history,
announcements, notifications, documents, emergency contacts, household access.

**Staff/security app:** fast visitor processing, search and verification,
check-in/out, incident reporting, work assignments, shift handovers.

Offline contingency workflows must have explicit synchronisation and conflict handling.
Stale offline permissions must never silently grant access.

## 10. API and integration standards

Versioned REST APIs, OpenAPI documentation, request validation, consistent error
responses, pagination, rate limiting, API authentication, webhook signatures,
idempotency and integration adapters.

Prepare adapters for payment gateways, email, SMS, push notifications, access-control
hardware, accounting platforms, identity providers, and maps/geolocation.
Core business logic must not be hardwired to any single external provider.

## 11. AI capabilities

AI is an optional intelligence layer, not a replacement for operational controls.
Candidates: resident support assistant, natural-language document search, maintenance
request classification, report generation, anomaly detection, maintenance forecasting,
financial trend analysis, notification summaries.

All AI features respect the same tenant and resource permissions as the application.
AI must never independently approve payments, grant physical access, change ownership,
or make other high-impact decisions.

## 12. Security and compliance

MFA for privileged users, secure authentication, encryption in transit and at rest,
strict authorisation, audit trails, secure file storage, rate limiting, input
validation, dependency scanning, secret scanning, backup and recovery, incident
response procedures, and penetration testing before significant commercial deployment.

Plan for privacy and security requirements in each target market. Do not claim GDPR,
ISO 27001 or any other certification without the formal compliance work.

## 13. Testing strategy

| Type              | Purpose                             |
| ----------------- | ----------------------------------- |
| Unit tests        | Domain and business rules           |
| Integration tests | Database and service interactions   |
| Contract tests    | API and external provider contracts |
| E2E tests         | Complete user workflows             |

Critical scenarios: cross-tenant data access, unauthorised financial access, expired
resident membership, duplicate payment callbacks, invalid visitor passes, concurrent
facility bookings, failed notifications, database transaction failures, permission
changes during active sessions, tenant data export and deletion.

## 14. DevOps and infrastructure

Two primary environments initially (cost-conscious):

- **Development:** local development, development database, test integrations,
  development deployment.
- **Production:** frontend, API, background workers, database, object storage,
  monitoring and backups.

CI must use isolated test databases and test services.

Implement Docker-based development, automated CI/CD, environment configuration, secrets
management, database migrations, health checks, logging and monitoring, error tracking,
backups, restore testing and deployment rollback.

## 15. Documentation

Maintain `docs/` throughout development (see the tree in the repository). Update
documentation whenever an architectural decision, workflow, API contract or operational
process changes. Record significant decisions as ADRs in `docs/adr/`.

## 16. Delivery phases

Do not implement the entire product in one pass.

| Phase | Deliverable                              |
| ----- | ---------------------------------------- |
| 0     | Repository audit and discovery           |
| 1     | Monorepo and engineering foundation      |
| 2     | Identity and multi-tenancy               |
| 3     | Organisation and property management     |
| 4     | Resident and unit management             |
| 5     | Visitor and access management            |
| 6     | Finance and billing                      |
| 7     | Maintenance and work orders              |
| 8     | Facilities and reservations              |
| 9     | Staff, vendors and assets                |
| 10    | Communications and documents             |
| 11    | Governance and incident management       |
| 12    | Analytics and integrations               |
| 13    | SaaS administration and subscriptions    |
| 14    | Security hardening and commercial launch |

Each phase requires acceptance criteria, tests, documentation and a review before
moving forward.

Get the tenant model, permissions, unit relationships and financial architecture right
before building visible features.

## 17. Agent operating rules

**NEVER:**

- Generate the whole application in one response.
- Create fake functionality to make screens appear complete.
- Use placeholder API responses in production flows.
- Bypass permissions for convenience.
- Duplicate business logic across applications.
- Ignore failing tests.
- Disable linting or type checking to force a build to pass.
- Make destructive database changes without a migration plan.
- Introduce unnecessary dependencies.
- Introduce microservices prematurely.
- Claim an integration works without verifying it.
- Claim a feature is complete without testing it.
- Commit secrets or real customer data.
- Run `git commit` or `git push`, or add co-author / AI attribution trailers.
  The repository owner commits manually.

**ALWAYS:**

- Inspect the repository before editing.
- Follow the existing architecture.
- Implement small, complete vertical slices.
- Write tests alongside implementation.
- Validate permissions server-side.
- Protect tenant boundaries.
- Review database migrations.
- Handle errors and edge cases.
- Update documentation.
- Report actual test results.
- Explain important architectural decisions.
- Identify technical debt.
# VEYRA Product Requirements Document

**Status:** Draft baseline for discovery and pilot planning  
**Product:** VEYRA  
**Primary initial market:** Condominium operations  
**Long-term market:** Global residential community and property operators

## 1. Goals

- Digitise core condominium administration and resident services.
- Establish trusted unit, resident, ownership, and tenancy records.
- Improve visitor and vehicle processing.
- Make maintenance work visible and accountable.
- Support transparent billing and payment tracking.
- Give management operational and financial oversight.
- Establish a secure multi-tenant foundation for future customers.

## 2. User types and access

| Persona | Typical capabilities | Restrictions |
|---|---|---|
| Platform operator | Provision organisations, platform support, platform configuration | No routine access to customer content; privileged support access must be approved and audited |
| Organisation administrator | Manage organisation settings and assigned properties | Cannot access other organisations |
| Property manager | Manage assigned property operations | Scope limited to assigned properties |
| Committee member | Review reports, vote, approve configured matters | No automatic access to resident private documents |
| Finance officer | Billing, payments, reconciliation, finance reports | No unrelated security or identity-document access |
| Security staff | Visitor processing, access logs, incidents | No financial or unrelated resident records |
| Maintenance staff | Assigned work orders, inspections, task updates | No broad resident or finance access |
| Owner | View authorised unit, bills, documents, requests | Only units and records for which access is granted |
| Tenant | Resident services for active tenancy | No owner-only records or owner governance rights unless separately granted |
| Household member | Limited resident services | Permission set delegated by authorised resident/owner |
| Vendor | Assigned work, limited site and schedule details | Only explicitly assigned jobs and minimum necessary information |

Use RBAC for role bundles and attribute/scope checks for organisation, property, building, unit, department, and resource. A role alone is not sufficient to authorise access.

## 3. Functional modules

### 3.1 Organisation and property hierarchy

- Create and configure organisations.
- Support multiple properties per organisation.
- Model property, building, floor, unit, common area, and parking inventory.
- Configure property currency, locale, IANA time zone, address, operational rules, and branding.
- Support property lifecycle states.
- Maintain history for material configuration changes.

### 3.2 Identity, membership, and resident records

- Authenticate users through a secure identity layer.
- Invite users and verify contact channels.
- Separate user identity from resident profile and property membership.
- Support owner, tenant, household member, committee, staff, and vendor relationships.
- Support multiple memberships and units per person.
- Record ownership and tenancy periods with effective dates.
- Support move-in, move-out, suspension, and access revocation.
- Store emergency contacts and vehicles only when necessary.
- Restrict sensitive identity documents with separate permissions and access logs.

### 3.3 Visitor and access management

- Resident pre-registration of expected visitors.
- Time-bounded, revocable visitor passes.
- QR or reference-code validation.
- Manual check-in for visitors without a pass.
- Record arrival, departure, gate, operator, and relevant vehicle details.
- Support delivery, contractor, service-provider, and guest categories.
- Show security staff only the minimum necessary resident and visitor information.
- Support denied entry and incident escalation.
- Provide offline contingency procedures for gate operations.
- Integrate hardware through provider adapters; do not assume all devices support the same protocol.
- Never treat a QR code alone as proof of identity.

### 3.4 Finance and billing

- Configure recurring charges, one-off charges, utility charges, deposits, penalties, and credits.
- Generate invoices and statements for the correct liable party/unit.
- Track due dates, allocations, adjustments, waivers, and disputes.
- Support online gateway payments and manual bank-transfer recording.
- Reconcile provider callbacks and bank statement imports.
- Issue receipts and account statements.
- Support refunds and reversals through controlled workflows.
- Maintain immutable posted ledger entries; correct mistakes with reversing/correcting entries.
- Support property-specific currency and accounting periods.
- Provide ageing, collection, income, expense, and budget reports.
- Keep payment credentials and card data with compliant payment providers; do not store raw card details.

### 3.5 Maintenance, complaints, and work orders

- Resident request submission with category, description, location, priority, and attachments.
- Triage, assignment, status tracking, internal notes, and resident-visible updates.
- Convert requests into work orders.
- Configure priority and service targets per property.
- Record labour, materials, costs, vendor, evidence, and completion.
- Support resident confirmation and reopening.
- Track SLA breaches and escalation.
- Maintain full history.

### 3.6 Facilities and reservations

- Configure bookable facilities, hours, capacity, slots, fees, deposits, and rules.
- Show availability in the property's time zone.
- Prevent overlapping reservations transactionally.
- Support approval, cancellation, waitlist (later), no-show, and maintenance blackout.
- Track refunds and deposits through finance workflows.
- Apply per-unit and per-user booking limits.

### 3.7 Staff and daily operations

- Staff profiles and department assignments.
- Shift schedules and handover notes.
- Task lists, checklists, inspections, and evidence.
- Work assignment and escalation.
- Leave and attendance integrations only if required and legally reviewed.
- Track task completion and supervisor verification.

### 3.8 Asset and vendor management

- Asset register with identifiers, location, category, warranty, supplier, and lifecycle state.
- Preventive maintenance schedules and service history.
- Vendor records, qualifications, contracts, insurance documents, and expiry dates.
- Quotation and purchase request workflows.
- Purchase orders and invoice matching can be phased.
- Restrict vendor portal access to assigned work.

### 3.9 Communications and documents

- Property-wide, building, floor, unit, role, and targeted announcements.
- In-app and push notifications, with email/SMS adapters.
- Delivery status and retry visibility.
- Templates and emergency broadcast workflow.
- Resident acknowledgement where required.
- Document categories, metadata, access policy, versioning, retention, and expiry reminders.
- Secure download links with short expiry and access checks.

### 3.10 Incidents and emergency operations

- Record incident type, severity, time, location, reporter, response, evidence, and outcome.
- Restrict sensitive incident records.
- Configure escalation contacts and procedures.
- Support emergency broadcasts with confirmation and audit records.
- Provide operational playbooks and post-incident actions.
- Do not imply the software replaces emergency services.

### 3.11 Governance and approvals

- Committee members and terms.
- Meetings, agendas, minutes, and resolutions.
- Configurable approval policies and thresholds.
- Expense, procurement, policy, and access approval workflows.
- Voting only after legal and governance requirements are validated.
- Preserve decision records and supporting documents.

### 3.12 Reporting and analytics

- Role-scoped operational dashboards.
- Finance, occupancy, maintenance, access, facilities, asset, and vendor reports.
- Export controls and audit logging.
- Scheduled reports in later phases.
- Ensure aggregate reports do not leak personal information through small groups or filters.

## 4. Cross-cutting non-functional requirements

### Security
- OIDC/OAuth2-compatible authentication.
- MFA for privileged roles; support stronger authentication policies.
- Server-side authorisation on every protected operation.
- Organisation and property isolation enforced in service and database layers.
- Rate limiting, input validation, secure headers, CSRF protections where applicable.
- Encryption in transit and at rest.
- Secrets management; no secrets in source control.
- Audit sensitive access and mutations.
- Dependency and container scanning in CI.

### Reliability
- Define pilot service objectives and error budgets.
- Health/readiness checks.
- Retries with backoff and idempotency for external callbacks.
- Backups with restore drills.
- Documented incident response and rollback.
- Graceful handling of notification, payment, and hardware provider outages.

### Performance
- Establish measurable performance budgets after baseline testing.
- Paginate large collections.
- Index real query patterns.
- Avoid N+1 database access.
- Use asynchronous jobs for non-interactive work.
- Load test critical workflows before broad rollout.

### Accessibility and usability
- Responsive web layouts.
- Keyboard navigation and screen-reader semantics.
- WCAG 2.2 AA target for web interfaces.
- Clear validation and error messages.
- Localised date, time, number, and currency display.
- Design for frontline staff using tablets and variable connectivity.

### Global readiness
- Store instants in UTC; retain property IANA time zone for local schedules.
- Store money as integer minor units or validated decimal values with currency metadata.
- Never assume every currency has two decimal places.
- Localise strings; do not hardcode country-specific labels into domain logic.
- Use country-specific adapters for payment, tax, identity, and messaging.
- Support configurable retention and data residency policies where required.

## 5. MVP acceptance criteria

The first pilot should not attempt every module. A credible MVP should include:

1. Organisation/property/building/floor/unit setup.
2. User invitation and resident membership.
3. Owner/tenant/unit relationships with effective dates.
4. Scoped roles and permissions.
5. Resident portal with unit information and announcements.
6. Visitor pre-registration and security check-in/check-out.
7. Maintenance request submission and work order tracking.
8. Basic recurring invoices, manual payment recording, receipts, and balances.
9. Audit log for privileged and sensitive actions.
10. Operational dashboard and essential reports.
11. Backup/restore process, monitoring, and documented support procedure.

Each capability must have tests for authorised access, denied access, cross-tenant access attempts, validation failures, and relevant state transitions.

## 6. Key user journeys

- Organisation admin provisions a property and imports units.
- Admin invites an owner; owner verifies account and claims/accepts a unit relationship.
- Owner invites a tenant or household member with scoped permissions.
- Resident registers a visitor; guard validates and records entry and exit.
- Resident raises a maintenance issue; manager triages and assigns; technician completes; resident receives update.
- Finance officer generates monthly invoices; resident pays or submits transfer reference; finance reconciles and issues receipt.
- Resident books a facility; system checks availability and rules; booking is confirmed or sent for approval.
- Manager reviews overdue work, outstanding invoices, and incident trends.

## 7. Product decisions still requiring discovery

- Exact pilot property structure, unit count, staffing, and operational processes.
- Existing accounting, access-control, CCTV, gate, payment, and messaging systems.
- Legal ownership and authority of the contracting organisation.
- Local data protection, condominium, financial, and electronic transaction requirements in each launch jurisdiction.
- Required languages and accessibility needs.
- Payment settlement and reconciliation model.
- Offline requirements at gates and plant rooms.
- Data migration and retention requirements.

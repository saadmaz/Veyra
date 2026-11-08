# User Journeys

Key end-to-end journeys from the [PRD](PRD.md). Each journey becomes a set of acceptance criteria
and at least one end-to-end test when its phase is built. Every journey must also be tested for
denied access, cross-tenant attempts, validation failures and state transitions.

| # | Journey | Actors | Phase |
| - | ------- | ------ | ----- |
| J1 | Provision a property and import units | Organisation admin | 3 |
| J2 | Invite an owner who verifies their account and accepts a unit relationship | Organisation admin, owner | 2-4 |
| J3 | Owner invites a tenant or household member with scoped permissions | Owner, tenant, household member | 4 |
| J4 | Resident registers a visitor; guard validates, records entry and exit | Resident, security guard | 5 |
| J5 | Resident raises a maintenance issue; manager triages and assigns; technician completes; resident is updated | Resident, property manager, technician | 7 |
| J6 | Finance generates monthly invoices; resident pays or submits a transfer reference; finance reconciles and issues a receipt | Finance officer, resident | 6 |
| J7 | Resident books a facility; system checks availability and rules; booking is confirmed or sent for approval | Resident, property manager | 8 |
| J8 | Manager reviews overdue work, outstanding invoices and incident trends | Property manager | 12 |

## Journey outlines

**J1 Provision a property.** Admin creates the property (address, currency, locale, IANA time
zone), adds buildings and floors, imports units from a file with row-level validation and a
preview, and confirms. The import is audited and idempotent if re-run.

**J2 Owner onboarding.** Admin invites by email to a unit with the Owner role. The invitation
token is single-use, expiring and stored hashed. The owner signs in through the identity
provider, verifies contact details and accepts. Ownership is recorded with an effective date and
access is granted from it.

**J3 Delegation.** Owner invites a tenant (creating a tenancy with start/end dates) or a
household member with a delegated permission subset. Access ends automatically at tenancy end or
on revocation.

**J4 Visitor entry.** Resident creates an invitation with a time window; VEYRA issues a random,
revocable pass (QR or code) that reveals no personal data. The guard scans it, the server checks
validity and window, the guard verifies identity, and records arrival and departure. Walk-ins
without a pass follow a manual check-in path with resident confirmation. A pass alone is never
proof of identity.

**J5 Maintenance.** Resident submits category, description, location and photos. Manager
triages and sets priority (driving the SLA), converts to a work order and assigns. The technician
records progress, evidence and cost, and completes. The resident confirms or reopens. SLA
breaches escalate.

**J6 Billing.** Finance runs the monthly charge schedule, producing invoices per liable party
and unit and posting ledger entries. The resident pays online (confirmed only by a verified
provider callback, never a browser redirect) or submits a bank-transfer reference that finance
matches. Receipts are issued and balances derived from the ledger.

**J7 Facility booking.** Resident picks a slot shown in the property's time zone. The server
checks rules, limits and overlap inside a transaction, and confirms or routes for approval.
Fees and deposits flow through finance.

**J8 Oversight.** Manager opens a role-scoped dashboard showing overdue work orders,
outstanding invoices and incident trends, drills into details, and exports with audit logging.

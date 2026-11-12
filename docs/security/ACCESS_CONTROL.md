# Access Control

> Status: Phase 6. Organisation-, property- and unit-level authorisation and derived resident
> grants are implemented (section 6). Building scope, custom roles and MFA for privileged roles
> are not yet.

## 1. Model: RBAC + resource scope + time

Every authorisation decision answers:
**can _user_ perform _permission_ on _resource_ within _scope_ at _time_, given _conditions_?**

- **Permission**: a fine-grained string `<module>.<resource>.<action>`, e.g.
  `finance.invoice.read`, `access.visitor.check_in`.
- **Role**: a named set of permissions. System roles are defined in code. Organisations may
  create custom roles composed only of permissions they are entitled to.
- **Membership**: grants a role to a user at a **scope**, for a **validity period**.

```
Membership {
  userId
  organisationId
  scopeType   ORGANISATION | PROPERTY | BUILDING | UNIT
  scopeId
  roleId
  validFrom   timestamptz
  validUntil  timestamptz | null
  status      INVITED | ACTIVE | SUSPENDED | REVOKED | EXPIRED
  grantedBy, grantedAt, revokedBy, revokedAt
}
```

Scope inheritance flows **downwards** only: an organisation-scoped role applies to all its
properties, a property-scoped role to its buildings and units. Never upwards or sideways.

Owner and tenant access is **derived** from ownership and tenancy records (Phase 4). An active
tenancy on a unit produces an effective `TENANT` grant on that unit for the tenancy period.
Ending the tenancy ends the access without manual clean-up.

## 2. Evaluation rules

1. **Deny by default.** No matching grant means `403`.
2. The grant must be `ACTIVE` with `validFrom <= now < validUntil` (compared in UTC).
3. The resource must belong to the grant's scope. This is checked by loading the resource's
   `organisationId / propertyId / unitId` on the server, never by trusting the client.
4. The organisation must be `ACTIVE` (or `SUSPENDED` with read-only permissions only).
5. The feature must be entitled by the subscription.
6. Conditional permissions ("approve expenses up to 5,000", "2 of N committee approvals")
   are evaluated by the owning module's policy after the base grant passes.
7. Privileged roles (platform admin, organisation admin, finance officer) require MFA
   for mutating operations (from session metadata while authentication is built in, ADR 0005;
   from the `amr` claim once an external identity provider is used).

Effective permissions may be cached per `(userId, organisationId)` in Redis for a short TTL.
Every membership change publishes an invalidation event so revocation takes effect within
seconds, not at token expiry.

## 3. Enforcement points

- **API**: a guard on every protected route, declared with
  `@RequirePermission('finance.invoice.read', scopeResolver)`. A boot-time check fails startup
  if any route has neither a permission declaration nor an explicit `@Public()` marker.
- **Queries**: list endpoints filter by the scopes the user holds. A manager of P1 listing
  units sees only P1's units.
- **Workers**: user-initiated jobs re-check the actor's permission at execution time.
- **Frontend**: hides what the user cannot do, for UX only. Never relied upon.
- **AI features**: run with the requesting user's permissions. Never elevated.

## 4. System role matrix (initial)

Legend: **M** manage, **A** approve, **R** read, **O** own/assigned records only, **-** none.

| Role                 | Granted at   | Org settings | Properties/units | Residents         | Visitors/access | Finance          | Maintenance  | Facilities  | Comms | Governance |
| -------------------- | ------------ | ------------ | ---------------- | ----------------- | --------------- | ---------------- | ------------ | ----------- | ----- | ---------- |
| Platform Super Admin | Platform     | audited support access only | - | -           | -               | -                | -            | -           | -     | -          |
| Organisation Admin   | Organisation | M            | M                | M                 | R               | R                | R            | M           | M     | R          |
| Property Manager     | Property     | -            | M                | M                 | M               | R                | M            | M           | M     | R          |
| Committee Member     | Property     | -            | R                | R                 | R               | R, A             | R            | R           | R     | M, A       |
| Finance Officer      | Org/Property | -            | R                | R                 | -               | M                | R            | R (fees)    | -     | R          |
| Security Supervisor  | Property     | -            | R                | R (verification)  | M               | -                | -            | -           | R     | -          |
| Security Guard       | Property     | -            | R                | R (verification)  | check-in/out    | -                | -            | -           | R     | -          |
| Maintenance Manager  | Property     | -            | R                | R                 | -               | -                | M            | R           | -     | -          |
| Technician           | Property     | -            | R                | -                 | -               | -                | O (assigned) | -           | -     | -          |
| Owner                | Unit         | -            | R (own unit)     | M (own household) | O               | O                | O            | O           | R     | R          |
| Tenant               | Unit         | -            | R (own unit)     | M (own household) | O               | O                | O            | O           | R     | -          |
| Household Member     | Unit         | -            | R (own unit)     | -                 | O (if delegated)| -                | O            | O (if delegated) | R | -          |
| Vendor               | Property     | -            | -                | -                 | -               | O (own invoices) | O (assigned) | -           | -     | -          |

Platform super admins **do not** see tenant data by default. Support access is a time-boxed,
reason-logged grant that is visible to the tenant.

## 5. Required tests

- Privilege escalation: a user cannot grant a role containing permissions they do not hold.
- Expired, future-dated and revoked memberships are denied.
- Cross-property: a manager of P1 cannot act on P2 in the same organisation.
- Cross-organisation: any membership in org A grants nothing in org B.
- Revocation during an active session takes effect on the next request.
- Every route declares a permission or is explicitly public (boot-time check test).

## 6. Implementation (Phase 2)

Code: `apps/api/src/modules/access-control` (registry, policy, guard, startup check) and
`apps/api/src/modules/organisations` (organisations, memberships, invitations).

### 6.1 Registry

- **Permissions** are a closed list in `access-control/domain/permissions.ts`. Today:
  `organisation.profile.read`, `organisation.settings.manage`, `organisation.member.read`,
  `organisation.member.manage`, `organisation.member.invite`, `organisation.property.create`,
  `property.profile.read`, `property.settings.manage`, `property.lifecycle.manage`,
  `property.structure.read` and `property.structure.manage`, the resident permissions below,
  and for visitors (Phase 5) `property.visitor.check_in` (operate a gate), `property.visitor.read`
  (visit log and invitations) and `property.visitor.manage` (revoke any invitation), and for finance (Phase 6) `property.finance.read` (chart of accounts, charge types, recurring charges, invoices) and `property.finance.manage` (set-up, charge types, recurring charges, billing runs, issuing and discarding invoices, payments, credit notes, closing periods and requesting approvals), and `property.finance.approve` (deciding someone else's request for a payment reversal, refund, write-off or period reopening; the requester can never decide their own request, enforced by the API and by a database CHECK). Each module
  adds its permissions with its first endpoint.
- **Three evaluation scopes.** `unit.*` permissions are evaluated against the route's `:unitId`,
  `property.*` against `:propertyId`, all others against the organisation. Unit permissions
  today: `unit.profile.read`, `unit.residents.read` (names and roles only, no contact details),
  `unit.visitor.invite` (register, list and revoke the unit's visitors), and for residents'
  finance (Phase 6 Part 6) `unit.finance.read` (your own account's invoices, receipts,
  statement and reported transfers) and `unit.finance.pay` (report a bank transfer for your own
  account). These are "your own account" permissions: the API resolves the account from the
  caller's own records on every request (an owner: the owners' account; a tenant: their current
  tenancy's), so holding the permission shows nothing without such a record. Organisation
  admins hold them too (every registered permission) and see nothing unless they own or rent
  the unit. For maintenance (Phase 7) `unit.maintenance.request` (raise and follow the unit's
  requests, resident-visible history only), `property.maintenance.read` (every request and work
  order of the property, internal notes and costs), `property.maintenance.manage` (triage, work
  orders, assignment, costs) and `property.maintenance.work` (be assigned work and carry it out:
  the "my work orders" routes show only work assigned to the caller; anyone else's is 404).
  Work can be assigned only to someone who holds `property.maintenance.work` at the property
  right now (checked by the API with the same policy, 422 `ASSIGNEE_NOT_ALLOWED`).
  For facilities (Phase 8) `unit.facility.book` (see the property's active facilities and their
  availability, book, follow and cancel the unit's bookings; residents cancel only before the
  facility's cancellation window, 409 `TOO_LATE_TO_CANCEL`), `property.facility.read` (every
  facility, closure and booking of the property) and `property.facility.manage` (set up
  facilities, opening hours and closures; approve, reject, cancel at any time, mark used or
  no-show). Availability shows only places left, never who booked.
  For vendors (Phase 9) `organisation.vendor.read` and `organisation.vendor.manage` are
  organisation-level: organisation admins hold both, finance officers read. Property staff never
  see the register; maintenance managers see active vendors to give work to through their
  property's maintenance routes.
  For staff operations (Phase 9) `property.staff.read`, `property.staff.manage` (organisation
  admins, property managers, maintenance managers and security supervisors) and
  `property.staff.work` (those roles plus security guards and technicians): a worker sees only
  their own shifts. Supervisors currently manage every department of their property.
  For announcements (Phase 10) `property.announcement.read` and `.manage` (organisation admins
  and property managers). The inbox needs only a signed-in user: a person sees only copies
  delivered to them, enforced by the query and by the database (only the recipient may update a
  copy).
  For documents (Phase 10) `property.document.manage` (organisation admins, property managers),
  `property.document.read` (also maintenance managers, security supervisors and guards,
  technicians and finance officers: documents for everyone or staff) and `unit.document.read`
  (owners, tenants and household members: documents for everyone or residents, owners also those
  for owners).
  For incidents (Phase 11) `property.incident.read` and `.report` (organisation admins, property
  managers, security supervisors and guards, maintenance managers and technicians) and
  `property.incident.manage` (organisation admins, property managers, security supervisors).
  Sensitive incidents are visible only to holders of `.manage` and to the person who reported
  them; others get 404. A follow-up action can be marked done by a manager or the person it was
  given to, who must hold `property.incident.read` at the property. Residents have no incident
  access yet.
  For governance (Phase 11) `property.governance.manage` (organisation admins, property
  managers) and `property.governance.read` (also the new **Committee member** role, granted per
  property, which also reads the property's documents). Seats go only to people holding
  `property.governance.read` at the property.
  For approvals (Phase 11) `property.approval.read` (organisation admins, property managers,
  maintenance managers, finance officers, committee members), `property.approval.request`
  (organisation admins, property and maintenance managers, finance officers) and
  `property.approval.decide` (organisation admins, property managers). A request sent to a
  committee is decided only by people holding a current seat on it; nobody decides their own
  request. Policies are kept with `property.governance.manage`.
  Dashboards (Phase 12) need only `property.profile.read`; each area is computed only for holders
  of that area's read permission (`property.structure.read`, `.finance.read`,
  `.maintenance.read`, `.visitor.read`, `.facility.read`, `.incident.read`, `.approval.read`), and
  sensitive incidents are counted only for holders of `property.incident.manage`.
  Exports (Phase 12) need `property.report.export` (organisation admins, property managers,
  finance officers, maintenance managers, security supervisors) **and** the area's read
  permission. They carry no visitor names or text written by residents; occupancy by building
  is suppressed below three units; every download writes a `report.exported` audit record with
  the report, row count and dates; at most 366 days and 10,000 rows; cells are defused against
  spreadsheet formula injection.
  Webhooks (Phase 12) are managed with `organisation.webhook.manage` (organisation admins). A
  secret is shown only when created or rotated. The worker refuses endpoints that resolve to
  private, loopback or link-local addresses (DNS rebinding included) and does not follow redirects.
- **System roles** live in `access-control/domain/roles.ts`:

  | Role | Grantable at | Permissions today |
  | ---- | ------------ | ----------------- |
  | `ORGANISATION_ADMIN` | Organisation | Every registered permission |
  | `PROPERTY_MANAGER` | Property | `property.profile.read`, `property.settings.manage`, `property.structure.read`, `property.structure.manage` (not lifecycle: activating and archiving stay with organisation admins), and `property.finance.read` (reads billing; does not run it), and all four maintenance permissions (runs maintenance, may do work), and the three facility permissions (Phase 8) |
  | `MAINTENANCE_MANAGER` | Property | `property.profile.read`, `property.structure.read`, `property.resident.read`, `unit.profile.read`, `unit.residents.read`, `unit.maintenance.request`, `property.maintenance.read`, `property.maintenance.manage`, `property.maintenance.work` (Phase 7; sees who lives where to arrange access; no finance or visitors) |
  | `TECHNICIAN` | Property | `property.profile.read`, `property.structure.read`, `property.maintenance.work` (Phase 7; only work assigned to them; no resident data: a work order shows the place and the problem, not who reported it) |
  | `FINANCE_OFFICER` | Organisation or property | `organisation.profile.read`, `property.profile.read`, `property.structure.read`, `unit.profile.read`, `property.finance.read`, `property.finance.manage`, `property.finance.approve` (Phase 6), and `property.maintenance.read` (maintenance costs for reporting, Phase 7). Sees the names of the people an invoice is addressed to through finance views, not the resident directory or contact details |
  | `SECURITY_SUPERVISOR` | Property | `property.profile.read`, `property.structure.read`, `property.visitor.check_in`, `property.visitor.read`, `property.visitor.manage`, `property.facility.read` (Phase 8: sees bookings to let people in) |
  | `SECURITY_GUARD` | Property | `property.profile.read`, `property.structure.read`, `property.visitor.check_in` (no resident data, no visit log) |
  | `OWNER`, `TENANT` | Unit (**derived**) | `unit.profile.read`, `unit.residents.read`, `unit.visitor.invite`, `unit.maintenance.request`, `unit.facility.book`, `unit.finance.read`, `unit.finance.pay` (owner decision, 2026-11-11: their own account only; a tenant never sees the owners' account, an owner never a tenancy's) |
  | `HOUSEHOLD_MEMBER` | Unit (**derived**) | `unit.profile.read`, `unit.visitor.invite`, `unit.maintenance.request` (owner decisions, 2026-11-11); no finance; no facility bookings until delegation exists (owner decision, 2026-11-12: only if delegated) |

  Organisation admins and property managers also hold `unit.profile.read`,
  `unit.residents.read`, `property.resident.read` and `property.resident.manage` (admins also
  `organisation.resident.read` for the organisation-wide directory); finance officers only
  `unit.profile.read` (no resident names or contact details until billing needs them).
  Answering a walk-in request needs `unit.visitor.invite` and a current derived resident role on
  the unit: staff hold the permission through their property but cannot let someone into a
  home on a resident's behalf (owner decision, 2026-11-11). In the same way, confirming or
  reopening a maintenance request needs a current derived resident role, and only the requester
  cancels a request from the unit's routes (staff cancel on the property's routes).
  Organisation admins and property managers also hold all four visitor permissions, gate
  operation included, so admins can appoint guards (anti-escalation: you can only give
  permissions you hold).
- **Resident visibility for property staff:** a property manager sees a person only if the
  person has a record (ownership, tenancy, household or vehicle, even past or voided) on one of
  the property's units, or no records at all yet (just created). People of other properties
  return 404. Maintenance and vendor roles arrive with their phases. A role
  key in the database that the registry does not know grants nothing.
- **Derived roles** are never stored as memberships and can never be assigned or invited
  (`canAssignRole` refuses them; invitations accept only `ASSIGNABLE_ROLE_KEYS`). They come from
  `app_resident_grants(user)`: an ACTIVE person profile linked to the user, with a non-voided
  ownership, tenancy (as occupant) or household record whose inclusive period contains **today
  in the property's time zone**. Access starts and ends with the records, on the next request.
- **Member baseline:** every effective member, at any scope, may read the organisation's basic
  profile (`organisation.profile.read`), so a property manager's console can name the
  organisation. Nothing else reaches upward.
- Custom per-organisation roles are not implemented.

### 6.2 Declaring access

Every route carries exactly one declaration:

| Decorator | Meaning |
| --------- | ------- |
| `@Public()` | No session (health, sign-up, sign-in) |
| `@Authenticated()` | Any signed-in user, no organisation context (my organisations, create organisation, accept invitation, sign-out) |
| `@RequirePermission('…')` | Signed-in effective member of the route's `:organisationId` holding the permission; for `property.*` permissions, at the route's `:propertyId` |

At startup, `RouteAccessVerifier` stops the application if a route has no declaration, names an
unregistered permission, requires a permission without `:organisationId` in its path, or
requires a `property.*` permission without `:propertyId`.

### 6.3 Evaluation (per request, no cache)

Global guards run in a fixed order: `AuthGuard` (session), then `PermissionGuard`. For
`@RequirePermission` routes:

1. The organisation id comes from the path only. A malformed id is treated as unknown.
2. The organisation and **all** of the user's memberships in it are read inside that tenant's
   RLS context.
3. No effective membership (rule 2) or no such organisation: **404 `NOT_FOUND`**. Outsiders
   cannot tell which organisations exist.
4. Effective member without the permission: **403 `FORBIDDEN`**.
5. Organisation `SUSPENDED` or `OFFBOARDING`: only `.read` permissions remain. `ARCHIVED`:
   nothing.

For property-scoped permissions (`property.*`), additionally:

6. The property id comes from the path and must belong to the organisation; otherwise 404.
7. Only grants that **cover** the property count: organisation-scoped grants, or a grant on that
   exact property. A property manager of P1 holds nothing over P2 and gets **404** there, so
   they cannot tell P2 exists. A building- or unit-scoped grant does not cover its property.
8. Covered but without the permission: 403. An `ARCHIVED` property keeps only `.read`
   permissions.
9. Lists (e.g. properties) are filtered server-side to the properties the caller's grants reach
   (`propertiesWithPermission`), never by a client-supplied filter.

For unit-scoped permissions (`unit.*`): the unit must belong to the route's property; covering
grants are organisation grants, grants on that property, or a (derived) grant on that unit.
A resident of U1 gets 404 on U2, on the property itself and on organisation member lists (403).
Any effective grant, including a derived one, makes the user a member with the baseline
`organisation.profile.read`.

Because grants are read on every request, suspension, revocation and expiry apply to the very
next request of an existing session.

### 6.4 Rules enforced by the organisations module

- **Creation:** any signed-in user can create an organisation (5 per day), becoming its first
  `ORGANISATION_ADMIN` in the same transaction.
- **Anti-escalation:** inviting to a role, or changing someone's membership, requires holding
  every permission of that role **over the target scope** (`ROLE_NOT_ASSIGNABLE`): all
  permissions of the actor's grants covering that scope (`permissionsForAssignment`). Nothing is
  assignable in a read-only organisation or an archived property.
- **Role scope:** a role can only be given at a scope it allows (`ROLE_SCOPE_MISMATCH`, 422):
  a property manager needs a `propertyId`; the property must belong to the organisation (404).
- **Last admin:** the last effective organisation admin cannot be suspended or revoked
  (`LAST_ADMIN`). Admin rows are locked during the check, so concurrent requests cannot both pass.
- **Transitions:** ACTIVE ↔ SUSPENDED, either → REVOKED. REVOKED is final; access returns only
  through a new invitation.
- **Invitations:**
  - bound to an email address, valid for 7 days and single use;
  - the token is shown once to the inviter and stored as a SHA-256 hash;
  - only an account with the invited email can accept (`INVITATION_EMAIL_MISMATCH`);
  - concurrent acceptances are serialised by a conditional update;
  - one pending invitation per email, role and scope (`INVITATION_PENDING`); an expired one is retired
    automatically.
- **Resident invitations** (`POST /organisations/:id/persons/:personId/invitations`, needs
  `organisation.member.invite`): role `RESIDENT`, sent to the profile's email; accepting links
  the profile to the login (`person.linked`) instead of creating a membership. Refused for
  profiles without email (422), already linked (409), archived (409), or when the login already
  has another profile in the organisation (409).
- Every change writes a tenant audit record in the same transaction: `organisation.created`,
  `organisation.updated`, `membership.granted`, `membership.status_changed`,
  `invitation.created`, `invitation.revoked`, `invitation.accepted`.

### 6.4a Subscription entitlements (rule 5, Phase 13)

Every permission belongs to a feature (`access-control/domain/entitlements.ts`, checked at
compile time); a plan turns features on, `core` always is. Permissions of features outside the
plan are removed whenever access is evaluated, so their routes answer 403 and the console hides
them. A cancelled subscription or an ended trial makes an active organisation read-only (rule 4);
`PAST_DUE` keeps everything working. The plan page uses `organisation.member.read`, a read
permission only organisation admins hold, so it stays visible while read-only.

### 6.5 Not yet implemented

- MFA for privileged mutations (rule 7) depends on MFA in authentication (ADR 0005 gap).
- Building and unit scopes and derived owner/tenant grants: later Phase 3 parts and Phase 4.
- Property managers cannot invite others to their property yet (organisation admins do).
- Platform super admin support access.
- Permission caching with invalidation events (not needed while reads are cheap).

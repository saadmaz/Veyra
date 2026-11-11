# Access Control

> Status: Phase 3. Organisation- and property-level authorisation are implemented (section 6).
> Building and unit scopes and derived (owner/tenant) grants arrive with later parts and Phase 4.

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
  (visit log and invitations) and `property.visitor.manage` (revoke any invitation). Each module
  adds its permissions with its first endpoint.
- **Three evaluation scopes.** `unit.*` permissions are evaluated against the route's `:unitId`,
  `property.*` against `:propertyId`, all others against the organisation. Unit permissions
  today: `unit.profile.read`, `unit.residents.read` (names and roles only, no contact details),
  `unit.visitor.invite` (register, list and revoke the unit's visitors).
- **System roles** live in `access-control/domain/roles.ts`:

  | Role | Grantable at | Permissions today |
  | ---- | ------------ | ----------------- |
  | `ORGANISATION_ADMIN` | Organisation | Every registered permission |
  | `PROPERTY_MANAGER` | Property | `property.profile.read`, `property.settings.manage`, `property.structure.read`, `property.structure.manage` (not lifecycle: activating and archiving stay with organisation admins) |
  | `FINANCE_OFFICER` | Organisation or property | `organisation.profile.read`, `property.profile.read`, `property.structure.read` (finance arrives in Phase 6) |
  | `SECURITY_SUPERVISOR` | Property | `property.profile.read`, `property.structure.read`, `property.visitor.check_in`, `property.visitor.read`, `property.visitor.manage` |
  | `SECURITY_GUARD` | Property | `property.profile.read`, `property.structure.read`, `property.visitor.check_in` (no resident data, no visit log) |

  | `OWNER`, `TENANT` | Unit (**derived**) | `unit.profile.read`, `unit.residents.read`, `unit.visitor.invite` |
  | `HOUSEHOLD_MEMBER` | Unit (**derived**) | `unit.profile.read`, `unit.visitor.invite` (owner decision, 2026-11-11) |

  Organisation admins and property managers also hold `unit.profile.read`,
  `unit.residents.read`, `property.resident.read` and `property.resident.manage` (admins also
  `organisation.resident.read` for the organisation-wide directory); finance officers only
  `unit.profile.read` (no resident names or contact details until billing needs them).
  Answering a walk-in request needs `unit.visitor.invite` and a current derived resident role on
  the unit: staff hold the permission through their property but cannot let someone into a
  home on a resident's behalf (owner decision, 2026-11-11).
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

### 6.5 Not yet implemented

- MFA for privileged mutations (rule 7) depends on MFA in authentication (ADR 0005 gap).
- Subscription entitlements (rule 5): Phase 13.
- Building and unit scopes and derived owner/tenant grants: later Phase 3 parts and Phase 4.
- Property managers cannot invite others to their property yet (organisation admins do).
- Platform super admin support access.
- Permission caching with invalidation events (not needed while reads are cheap).

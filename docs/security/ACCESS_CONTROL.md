# Access Control

> Status: Phase 0 baseline. Implemented in Phase 2.

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
   (`amr` claim from the identity provider) for mutating operations.

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

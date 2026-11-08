# Multi-Tenancy

> Status: Phase 2. Decision recorded in [ADR 0002](../adr/0002-multi-tenancy.md). Database
> enforcement (roles, context functions, RLS) is implemented: see section 3.

## 1. Tenant hierarchy

```
Platform
└── Organisation            <- the tenant (billing, contracts, data ownership)
    └── Property            <- a community / condominium / complex
        └── Building        <- tower / block
            └── Floor
                └── Unit
```

- The **Organisation** is the isolation boundary. All business data belongs to exactly one
  organisation.
- A self-managed condominium is an organisation with one property.
- Users are **global** (one login) and join tenants through **memberships**. A user can be
  an owner in one organisation and a property manager in another.

## 2. Isolation strategy

**Shared database, shared schema, tenant key on every tenant-owned row**, enforced in three
layers:

| Layer          | Mechanism | Purpose |
| -------------- | --------- | ------- |
| 1. Application | Tenant context is mandatory for every repository call. Repositories add `organisation_id` to every query. Unscoped access only through an explicit, audited platform path. | Primary enforcement |
| 2. Schema      | Every tenant-owned table has `organisation_id NOT NULL`. Children reference parents with **composite foreign keys** `(organisation_id, parent_id)`, so a row can never point at another tenant's parent. | Cross-tenant references cannot be stored |
| 3. Database    | PostgreSQL **Row-Level Security** on tenant-owned tables using `current_setting('app.organisation_id')`, set with `SET LOCAL` in each transaction. The application role does not bypass RLS. | Defence in depth against a missed filter |

Why not schema-per-tenant or database-per-tenant: migrations across thousands of schemas,
connection-pool fragmentation and cross-tenant platform reporting are expensive for a
cost-conscious product. A dedicated deployment can still be offered to an enterprise
customer by running a separate stack with identical code.

## 3. Database enforcement (implemented, Phase 2)

Source: `packages/db/prisma/migrations/20261108120000_identity_and_tenancy/migration.sql`
(hand-written section below the generated DDL). Proven by
`packages/db/test/integration/rls.int.test.ts` against a real PostgreSQL 17.

### 3.1 Database roles

| Role | Used by | Privileges |
| ---- | ------- | ---------- |
| `veyra_owner` | `prisma migrate` (`MIGRATION_DATABASE_URL`) | Owns the database and schema. Not a superuser. Dev only: `CREATEDB` for Prisma's shadow database. |
| `veyra_app` | API and worker (`DATABASE_URL`) | `NOSUPERUSER NOBYPASSRLS`. Only the table privileges granted in the migration: no DDL, no `TRUNCATE`, no `DELETE` on organisations, memberships, invitations or audit logs. |
| superuser (`postgres`) | Administration only | Bypasses RLS. **The application must never connect as a superuser.** |

Local and test roles come from `packages/db/sql/bootstrap-roles.sql` (development passwords).
Production roles and passwords are created by the deployment from a secrets manager. The
migration grants to `veyra_app`, so the role must exist before migrations run.

### 3.2 Request context

The application sets two transaction-local settings (`set_config(name, value, true)`, the
function form of `SET LOCAL`, with the value bound as a parameter). The policies read them
through two SQL functions:

| Setting | Function | Set by |
| ------- | -------- | ------ |
| `app.organisation_id` | `app_current_organisation_id()` | `withTenantTransaction(client, tenant, work, { userId })` |
| `app.user_id` | `app_current_user_id()` | `withTenantTransaction` (optional `userId`) and `withUserTransaction(client, userId, work)` |

Both functions return `NULL` when the setting is absent or reset (`NULLIF(..., '')`), so a
query without context matches no policy and sees no rows. Settings end with the transaction,
so pooled connections never carry one request's tenant into the next (tested).

### 3.3 Policies

`ENABLE` **and** `FORCE ROW LEVEL SECURITY`: FORCE applies the policies to the table owner
too, so a migration-role connection cannot read across tenants by accident. An operation with
no policy is denied.

| Table | SELECT | INSERT / UPDATE | DELETE |
| ----- | ------ | --------------- | ------ |
| `organisations` | Current tenant, **or** organisations where the current user has an `ACTIVE` membership | Current tenant only | No grant |
| `memberships` | Current tenant's rows, **or** the current user's own rows | Current tenant only (`WITH CHECK` stops moving a row to another tenant) | No grant |
| `invitations` | Current tenant, **or** the single row whose `token_hash` the caller presents (`app.invitation_token_hash`) | Current tenant only | No grant |
| `audit_logs` | Current tenant only | Current tenant, or platform events (`organisation_id IS NULL`) | Rejected by trigger |

**User context.** Before an organisation is chosen ("list my organisations"),
`withUserTransaction` sets only `app.user_id`. The user then sees their own memberships and the
organisations they actively belong to, nothing else. Suspending or revoking a membership
removes that visibility immediately. Membership validity windows (`valid_from` /
`valid_until`) are checked by the permission engine (access-control module), not by RLS.

**Global tables without RLS.** `users`, `password_credentials`, `sessions` and
`outbox_events` are not tenant-owned. They are reachable only through the identity module and
the worker's outbox relay; they are never exposed through tenant-scoped endpoints.

**Audit log.** Append-only for every role: a trigger rejects `UPDATE`, `DELETE` and `TRUNCATE`,
including from a superuser. Platform events (sign-in, sign-up) are written with no tenant and
are invisible to tenants.

### 3.4 Caveats

- Superusers and roles with `BYPASSRLS` ignore every policy. A test asserts `veyra_app` has
  neither attribute; production connection strings must be reviewed for the same.
- RLS is defence in depth. Repositories still filter by `organisation_id`, and the permission
  guard still authorises every request ([ACCESS_CONTROL](../security/ACCESS_CONTROL.md)).
- Composite tenant foreign keys arrive in Phase 3 with the first tenant-owned child tables
  (properties, buildings, units). Today the only cross-table scope check is
  `memberships_org_scope_matches` (an organisation-scoped membership must point at its own
  organisation).
- **Invitation acceptance** happens before the invitee has tenant context. Instead of the
  planned `SECURITY DEFINER` function (it would run as `veyra_owner`, which FORCE RLS also
  restricts), the SELECT policy admits the one invitation whose token hash the caller sets in
  `app.invitation_token_hash` (`withInvitationTokenTransaction`). Knowing the hash requires the
  256-bit token. The setting grants read only; acceptance then runs in the invitation's tenant
  context. Migration `20261108160000_invitation_token_lookup`.

## 4. Tenant context propagation

| Entry point       | How the tenant is resolved |
| ----------------- | -------------------------- |
| HTTP              | From the route: `/api/v1/organisations/:organisationId/...` (and `/properties/:propertyId/...`). The user's active membership is verified before the handler runs. |
| Background jobs   | From the job envelope. A job without tenant context fails unless it is a declared platform job. |
| Domain events     | Every event carries `organisationId`. |
| Inbound webhooks  | From the integration record that owns the webhook secret, never from the payload alone. |
| Exports / reports | Generated by tenant-aware jobs, stored under a tenant-prefixed key, served through short-lived signed URLs after an authorisation check. |

The resolved context is held in request-scoped `AsyncLocalStorage` and is read-only for the
rest of the request. The shared type lives in `packages/domain` (`TenantContext`).

## 5. Tenant lifecycle

`PENDING_ONBOARDING -> ACTIVE -> SUSPENDED -> (ACTIVE | OFFBOARDING) -> ARCHIVED -> DELETED`

- **Suspended**: read-only or blocked, depending on the reason (non-payment vs security).
- **Offboarding**: tenant data export produced on request.
- **Deleted**: personal data hard-deleted after the contractual retention period. Financial
  records retained only where legally required, then deleted.

## 6. Configuration and entitlements

- Organisation- and property-level settings are typed, versioned rows, not untyped JSON.
- Feature entitlements come from the subscription (Phase 13) and are checked server-side
  alongside permissions: "allowed by role" **and** "included in plan".

## 7. Required tests (Phase 2 onwards)

- A user of organisation A cannot read, list, update or delete organisation B's data through
  any endpoint (parameterised across all routes).
- A composite FK rejects a child row that points at another tenant's parent.
- A query without `app.organisation_id` set returns no rows from RLS-protected tables.
- Jobs without tenant context are rejected.
- Exports contain only the requesting tenant's data.

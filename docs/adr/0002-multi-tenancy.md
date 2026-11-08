# ADR 0002: Multi-tenancy model

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

VEYRA serves many organisations, from single self-managed condominiums to property
management companies with dozens of properties. Data leakage between tenants would be
catastrophic. Options considered:

| Option | Isolation | Cost / ops | Cross-tenant platform reporting |
| ------ | --------- | ---------- | ------------------------------- |
| Database per tenant | Strongest | High: many DBs, migrations, connections | Hard |
| Schema per tenant | Strong | Medium-high: migrations x N, pool fragmentation | Hard |
| Shared schema + tenant key | Depends on enforcement | Low | Easy |

## Decision

Shared database, shared schema, `organisation_id` on every tenant-owned row, enforced by:

1. Mandatory tenant context in the application layer (repositories always scope queries).
2. Composite foreign keys `(organisation_id, parent_id)` so cross-tenant references cannot be stored.
3. PostgreSQL Row-Level Security keyed on `current_setting('app.organisation_id')`, set per
   transaction with `SET LOCAL`, using an application role that cannot bypass RLS.

Details: [MULTI_TENANCY](../architecture/MULTI_TENANCY.md).

## Consequences

- Low cost and one migration path for all tenants.
- Every tenant-owned query must run inside a transaction that sets the tenant setting;
  this is wrapped in a shared helper so feature code cannot forget it.
- Prisma does not manage RLS policies; they are written as raw SQL inside Prisma migrations
  and covered by integration tests.
- Enterprise customers needing physical isolation get a dedicated deployment of the same code.

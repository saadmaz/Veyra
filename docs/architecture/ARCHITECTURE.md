# Architecture

> Status: Phase 0 baseline. Update whenever a module boundary, process or data flow changes.

## 1. Style

VEYRA is a **modular monolith** (see [ADR 0001](../adr/0001-modular-monolith.md)):
one backend codebase, split into business modules with hard boundaries, running as two
process types that scale independently.

```
                 +---------------------------+
  Browser ------>| apps/web (Next.js)        |--+
                 +---------------------------+  |  HTTPS /api/v1 (REST + OpenAPI)
  Flutter app ----------------------------------+
  Integrations / webhooks ----------------------+
                                                v
                 +-------------------------------------------+
                 | apps/api  (NestJS, stateless, N replicas) |
                 |  - platform: auth, tenancy, authz, audit  |
                 |  - modules: organisation, residents, ...  |
                 +--------+----------------+-----------------+
                          | SQL            | enqueue jobs
                          v                v
                 +--------------+   +-----------+    +-------------------------+
                 | PostgreSQL   |   |  Redis    |<---| apps/worker (BullMQ)    |
                 | source of    |   |  cache +  |    | same modules, no public |
                 | truth        |   |  queues   |    | HTTP, N replicas        |
                 +--------------+   +-----------+    +-------------------------+
```

- **apps/api** serves synchronous requests. Stateless; any replica can serve any request.
- **apps/worker** runs background jobs (notifications, billing runs, exports, outbound
  webhooks, scheduled reports). It uses the same module code as the API and exposes only
  a health endpoint.
- **PostgreSQL** is the only authoritative store. **Redis** holds caches, rate-limit
  counters, queues and ephemeral pub/sub. Losing Redis must never lose business data.
- **Object storage** (S3-compatible) holds files. The database holds file metadata and
  the tenant that owns every object.

## 2. Module structure

Each business module is organised in layers:

```
<module>/
  domain/          entities, value objects, domain services, domain events (no framework imports)
  application/     use cases (commands/queries) and ports (repository/provider interfaces)
  infrastructure/  Prisma repositories, provider adapters, queue producers/consumers
  presentation/    controllers, DTOs, OpenAPI decorators
  <module>.module.ts
```

Rules:

1. Dependencies point inward: presentation -> application -> domain. Infrastructure
   implements application ports.
2. A module never imports another module's `domain/` or `infrastructure/`. It calls another
   module only through that module's exported **application interface**, or reacts to its
   **domain events**.
3. No circular module dependencies. A dependency check is added to CI once a second
   business module exists.
4. Cross-cutting **platform** concerns live in `apps/api/src/platform`: configuration,
   authentication, tenant context, authorisation, auditing, errors, health, logging.
5. Framework-free shared building blocks (money, identifiers, tenant context types, errors)
   live in `packages/domain` so the API, worker and web share one implementation.

## 3. Planned modules

| Module                    | Phase | Owns                                                         |
| ------------------------- | ----- | ------------------------------------------------------------ |
| identity                  | 2     | users, external identities                                   |
| tenancy                   | 2     | organisations, memberships, roles, permissions, entitlements |
| property                  | 3     | properties, buildings, floors, units, common areas           |
| residents                 | 4     | ownership, tenancy, households, vehicles                     |
| access                    | 5     | visitors, passes, check-in/out, access events                |
| finance                   | 6     | ledger, invoices, payments, receipts                         |
| maintenance               | 7     | requests, work orders, SLAs                                  |
| facilities                | 8     | facilities, reservations                                     |
| workforce, vendors, assets | 9    | staff, shifts, vendors, procurement, assets                  |
| communications, documents | 10    | announcements, notifications, files                          |
| governance, incidents     | 11    | committees, meetings, resolutions, incidents                 |
| analytics, integrations   | 12    | reporting read models, external APIs                         |
| platform-admin, billing   | 13    | SaaS subscriptions, plans, usage                             |

## 4. Request lifecycle (API)

1. Request ID assigned or propagated (`x-request-id`).
2. Authentication guard validates the OIDC access token and resolves the internal user.
3. Tenant context is resolved from the route (`/organisations/:organisationId/...`), never
   from a client header alone, and the user's membership in it is verified.
4. Authorisation guard evaluates the required permission against the resolved scope.
5. Validation pipe validates the request DTO.
6. The use case runs inside a transaction when it mutates state. The audit record and
   outbox events are written in the same transaction.
7. Errors are mapped to the standard error envelope (see [API_DESIGN](API_DESIGN.md)).

## 5. Asynchronous work

- Domain events are written to an **outbox table** in the same transaction as the state
  change, then relayed to BullMQ by the worker. This prevents "saved but event lost".
- Every job carries a **job envelope**: `organisationId`, optional `propertyId`, `actorId`,
  `requestId`, `idempotencyKey`. Workers re-establish tenant context from the envelope and
  re-check permissions for user-initiated work.
- Jobs are idempotent. Retries use exponential back-off and failed jobs are retained for
  inspection (dead-letter).

## 6. Extraction path

A module becomes a candidate for extraction only with a measurable need (independent
scaling, separate team, different compliance boundary). Because modules talk through
interfaces and events, extraction replaces an in-process call with a network call and
the outbox relay with a broker, rather than requiring a rewrite.

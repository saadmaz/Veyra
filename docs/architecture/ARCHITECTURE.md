# Architecture

> Status: Phase 0 baseline. Update whenever a module boundary, process or data flow changes.

## 1. Style

VEYRA is a **modular monolith** (see [ADR 0001](../adr/0001-modular-monolith.md)):
one backend codebase, split into business modules with hard boundaries, running as two
process types that scale independently.

```
                 +------------------------------+
  Browser ------>| apps/console-web (Next.js)   |--+
                 | apps/admin-web   (Next.js)   |  |  HTTPS /api/v1 (REST + OpenAPI)
                 +------------------------------+  |
  apps/resident-mobile (React Native) -------------+
  Integrations / webhooks -------------------------+
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

Client surfaces (all talk to the same versioned API, behind an edge layer providing TLS,
CDN and WAF, e.g. Cloudflare):

| Surface | App | Users |
| ------- | --- | ----- |
| VEYRA Console | `apps/console-web` (Next.js) | organisation admins, property managers, finance, committee |
| VEYRA Operations | responsive PWA inside `apps/console-web` (split out only if needed) | security guards, technicians, frontline staff |
| VEYRA Resident | `apps/resident-mobile` (React Native + Expo) | owners, tenants, household members |
| VEYRA Platform Admin | `apps/admin-web` (Next.js) | VEYRA staff only |
| Public website | `apps/marketing-web` (Next.js, static, no API access needed) | prospects, the public |
| Platform APIs | `apps/api` | integrations, partners |

- **apps/api** serves synchronous requests. Stateless; any replica can serve any request.
- **apps/worker** runs background jobs (notifications, billing runs, exports, outbound
  webhooks, scheduled reports). It uses the same module code as the API and exposes only
  a health endpoint.
- **PostgreSQL** is the only authoritative store. **Redis** holds caches, rate-limit
  counters, queues and ephemeral pub/sub. Losing Redis must never lose business data.
- **Object storage** (S3-compatible) holds files. The database holds file metadata and
  the tenant that owns every object. Browsers upload and download with short-lived signed URLs;
  the API checks every upload before it is shown ([ADR 0007](../adr/0007-object-storage.md)).

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
   module only through that module's exported **application interface** (its `index.ts`, e.g.
   `modules/access-control/index.ts`), or reacts to its **domain events**.
3. No circular module dependencies. A dependency check is added to CI once a second
   business module exists.
4. Cross-cutting **platform** concerns live in `apps/api/src/platform`: configuration,
   authentication, tenant context, authorisation, auditing, errors, health, logging.
5. Framework-free shared building blocks (money, identifiers, tenant context types, errors)
   live in `packages/domain` so the API, worker and web share one implementation.

## 3. Planned modules

Introduce a module only when a real use case is being implemented. Do not create empty modules
to match this list.

| Module          | Phase | Owns |
| --------------- | ----- | ---- |
| identity        | 2     | user identity references, external identities, invitations, session integration |
| organisations   | 2     | customer organisations, organisation lifecycle and memberships |
| access-control  | 2     | roles, permissions, grants, policy evaluation |
| audit           | 2     | append-only audit event capture and query interfaces |
| properties      | 3     | properties, buildings, floors, units, common areas, parking inventory |
| residents       | 4     | person profiles, ownership, tenancy, household relationships |
| vehicles        | 4     | vehicles and parking relationships |
| visitors        | 5     | invitations, passes, check-in/out, access events |
| finance         | 6     | charges, invoices, payments, allocations, receipts, ledger, reconciliation |
| maintenance     | 7     | requests, work orders, SLAs, escalation |
| facilities      | 8     | facilities, schedules, reservations, capacity and rules |
| workforce       | 9     | staff, shifts, tasks, inspections, handovers |
| assets          | 9     | asset registry and preventive maintenance |
| vendors         | 9     | vendor profiles and contracts |
| procurement     | 9     | requests, quotations, purchase orders, approvals |
| communications  | 10    | announcements and message templates |
| notifications   | 10    | delivery orchestration and provider adapters |
| documents       | 10    | metadata, access policy, versioning, storage integration |
| incidents       | 11    | incidents and emergency procedures |
| governance      | 11    | committees, meetings, resolutions, voting where legally validated |
| reporting       | 12    | role-scoped read models and exports |
| integrations    | 12    | provider registry, webhooks, sync jobs |
| platform-admin  | 13    | platform provisioning, support tooling, subscriptions, entitlements |

Controllers stay thin: authenticate, validate, invoke the use case, map the response. Public API
contracts are kept separate from ORM/database models.

## 4. Request lifecycle (API)

1. Request ID assigned or propagated (`x-request-id`).
2. Authentication guard validates the session token (cookie or bearer) through the identity
   port and resolves the internal user ([ADR 0005](../adr/0005-built-in-authentication.md):
   built-in today, an OIDC provider later).
3. Tenant context is resolved from the route (`/organisations/:organisationId/...`), never
   from a client header alone, and the user's membership in it is verified.
4. Authorisation guard evaluates the required permission against the resolved scope. Both
   guards are global and deny by default; startup fails if a route declares no access level.
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
  inspection (dead-letter). Queue depth and failures are visible on an operational dashboard.

Typical background work: notifications and retries, invoice generation batches, payment
reconciliation, document processing, scheduled maintenance reminders, SLA escalation, report
generation, and external system synchronisation.

## 6. Data and consistency

- PostgreSQL is the system of record; all schema changes go through migrations.
- Transactions wrap multi-record business invariants.
- Idempotency keys for payment creation, webhook processing and retryable commands.
- Read models / materialised views only when measured query needs justify them.
- Redis is never the authoritative store for finance or access history.
- Timestamps are UTC instants; each property keeps its IANA time zone for local schedules.
- Every money amount carries its currency code.

See [DATA_MODEL](DATA_MODEL.md) and [MULTI_TENANCY](MULTI_TENANCY.md).

## 7. Integration architecture

Provider interfaces (ports) exist for payment gateways, email, SMS and push, access-control
devices, accounting exports/imports, identity providers, and maps/geocoding. Core domain logic
never binds to one provider's SDK or payload model: adapters translate provider-specific events
into internal commands and events. Inbound webhooks are signature-verified, replay-protected and
idempotent on the provider event ID.

## 8. Deployment evolution

Start with the simplest topology that supports the pilot: web app, API, worker, PostgreSQL,
Redis, object storage and an observability stack. API and worker are separate processes from one
codebase. Add replicas and managed infrastructure as load and availability needs become known.

## 9. Extraction path

A module becomes a candidate for extraction only with a clear reason: independent scaling, team
ownership, fault isolation, a distinct release cadence, or provider/device integration
constraints. Because modules talk through interfaces and events, extraction replaces an
in-process call with a network call and the outbox relay with a broker, rather than requiring a
rewrite. Every extraction needs an ADR covering data ownership, API contract, migration,
observability and rollback.

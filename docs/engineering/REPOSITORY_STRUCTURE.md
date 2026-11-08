# Repository Structure

Bun workspaces + Turborepo for TypeScript apps and packages. Flutter lives in the same
repository as a first-class app but is not a Bun workspace package.

## Current layout (Phase 1)

```
.
├── AGENTS.md                 Engineering brief for AI agents
├── apps/
│   ├── api/                  NestJS HTTP API (/api/v1)
│   │   ├── src/
│   │   │   ├── main.ts       Process entry: load env, create app, listen
│   │   │   ├── bootstrap.ts  Global HTTP config (helmet, CORS, prefix, versioning, OpenAPI)
│   │   │   ├── app.module.ts
│   │   │   └── platform/     Cross-cutting: config, errors, validation, request-id, health, infrastructure
│   │   └── test/             Vitest unit + e2e (supertest)
│   ├── worker/               BullMQ worker process + health endpoint
│   └── web/                  Next.js (App Router): becomes VEYRA Console
├── packages/
│   ├── domain/               Framework-free shared kernel: Money, TenantContext, JobEnvelope, DomainError
│   └── db/                   Prisma schema, client factory, tenant transaction helper
├── docs/
├── .github/workflows/ci.yml
├── docker-compose.yml        Local PostgreSQL + Redis
├── biome.json · turbo.json · tsconfig.base.json · package.json
```

## Target layout

Grow towards this as features need it. Do not create folders ahead of real code.

```
apps/
├── api/                      NestJS API
│   └── src/
│       ├── platform/         config, auth, tenancy context, authz, errors, health, logging
│       └── modules/          organisations, properties, residents, access-control, visitors,
│                             finance, maintenance, facilities, workforce, assets, vendors,
│                             communications, notifications, documents, incidents, governance,
│                             reporting, integrations, audit
├── worker/                   BullMQ worker (same module code, no public HTTP)
├── web/                      VEYRA Console (Next.js); may be renamed apps/console
├── operations/               VEYRA Operations PWA, only if it outgrows the console app
└── mobile/                   VEYRA Resident (Flutter): lib/{app,core,features,shared}, test/, pubspec.yaml
packages/
├── domain/                   stable shared primitives only (blueprint name: domain-shared)
├── db/                       Prisma schema and migrations
├── api-contracts/            OpenAPI-derived schemas and client types; no business logic
├── design-tokens/            semantic tokens shared across web and mobile
├── observability/            logging/tracing setup and interfaces
└── test-kit/                 fixtures and helpers; never secrets or personal data
infrastructure/
├── docker/                   production Dockerfiles
├── environments/
├── monitoring/
└── terraform/                when hosting is selected
scripts/
```

Deviations from the original blueprint, and why:

- `apps/web` instead of `apps/console`: same app; renaming is cheap later and not worth churn now.
- `apps/worker` exists as its own app because the API and worker are separate processes (ADR 0001).
- `packages/db` holds Prisma, since the schema is shared by API and worker.
- `docker-compose.yml` is at the root for local development; production Docker assets go in
  `infrastructure/docker/` when deployment is set up.
- Shared TypeScript config is `tsconfig.base.json`; Biome replaces ESLint (ADR 0003), so no
  `config-eslint` package.

## Backend module layout

```
modules/visitors/
├── domain/           entities, value-objects, policies, events, errors
├── application/      commands, queries, handlers, ports, dto
├── infrastructure/   persistence, providers, mappers
├── presentation/     http controllers, request/response schemas
└── visitors.module.ts
```

Do not create every folder for trivial modules. Keep the separation where it improves clarity
and testability.

## Frontend feature layout

```
src/features/visitors/
├── api/  components/  hooks/  schemas/  types/
```

Shared UI components stay separate from domain features. No global `utils` dumping ground.

## Package dependency rules

| Package           | May depend on |
| ----------------- | ------------- |
| `packages/domain` | nothing internal; no frameworks |
| `packages/db`     | `domain` |
| `apps/api`        | `domain`, `db` |
| `apps/worker`     | `domain`, `db` |
| `apps/web`        | `domain` (types/value objects only); talks to the API over HTTP, never to the database |

Business logic lives in API modules (or `domain`), never duplicated in web or mobile.

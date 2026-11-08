# Repository Structure

Bun workspaces + Turborepo.

```
.
├── AGENTS.md                 Master engineering brief for AI agents
├── apps/
│   ├── api/                  NestJS HTTP API (/api/v1)
│   │   ├── src/
│   │   │   ├── main.ts       Process entry: load env, create app, listen
│   │   │   ├── bootstrap.ts  Global HTTP config (helmet, CORS, prefix, versioning, OpenAPI)
│   │   │   ├── app.module.ts
│   │   │   ├── platform/     Cross-cutting: config, errors, validation, request-id, health, infrastructure
│   │   │   └── modules/      Business modules (from Phase 2)
│   │   └── test/             Vitest unit + e2e (supertest)
│   ├── worker/               BullMQ worker process + health endpoint
│   ├── web/                  Next.js (App Router) web app
│   └── mobile/               Flutter app (not yet created, needs Flutter SDK)
├── packages/
│   ├── domain/               Framework-free shared kernel: Money, TenantContext, JobEnvelope, DomainError
│   └── db/                   Prisma schema, migrations, client factory, tenant transaction helper
├── docs/                     Product, architecture, security, engineering, operations, ADRs
├── docker-compose.yml        Local PostgreSQL + Redis
├── biome.json                Lint + format
├── turbo.json                Task pipeline
└── tsconfig.base.json        Shared strict TypeScript settings
```

## Package dependency rules

| Package           | May depend on                     |
| ----------------- | --------------------------------- |
| `packages/domain` | nothing internal; no frameworks   |
| `packages/db`     | `domain`                          |
| `apps/api`        | `domain`, `db`                    |
| `apps/worker`     | `domain`, `db`                    |
| `apps/web`        | `domain` (types/value objects only); talks to the API over HTTP, never to the database |

Business logic lives in the API's modules (or `domain`), never duplicated in web or mobile.

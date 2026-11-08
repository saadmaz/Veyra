# Repository Structure

Bun workspaces + Turborepo. Every app and package is a workspace, including the React Native
app. Overviews with ports and URLs: [apps/README.md](../../apps/README.md),
[packages/README.md](../../packages/README.md).

## Naming convention

- **User-facing apps:** `<product>-<platform>`: `console-web`, `resident-mobile`,
  `marketing-web`, `admin-web`. The name says who it is for and where it runs.
- **Backend processes:** plain role names: `api`, `worker`.
- **Packages:** what they contain: `domain`, `db`, `api-contracts`, `design-tokens`, `emails`,
  `web-config`. npm scope `@veyra/*`, matching the folder name.
- Folders and files in kebab-case; React components and classes in PascalCase.

## Layout

```
.
├── AGENTS.md                     Engineering brief for AI agents
├── apps/
│   ├── api/                      VEYRA API: NestJS REST API (/api/v1)
│   │   ├── src/
│   │   │   ├── main.ts           Process entry: load env, create app, listen
│   │   │   ├── bootstrap.ts      Global HTTP config (helmet, CORS, prefix, versioning, OpenAPI)
│   │   │   ├── app.module.ts
│   │   │   ├── platform/         config, errors, validation, request-id, health, infrastructure
│   │   │   └── modules/          business modules (from Phase 2)
│   │   └── test/
│   ├── worker/                   VEYRA Worker: BullMQ jobs + health endpoint
│   ├── console-web/              VEYRA Console + Operations PWA (Next.js)
│   ├── resident-mobile/          VEYRA Resident (React Native + Expo Router)
│   │   ├── app/                  screens/routes
│   │   ├── src/lib/              API client, config, non-UI logic
│   │   └── test/
│   ├── marketing-web/            Public website (Next.js)
│   └── admin-web/                Internal platform admin (Next.js)
├── packages/
│   ├── domain/                   Money, TenantContext, JobEnvelope, DomainError
│   ├── db/                       Prisma schema and migrations, client, tenant transaction helper
│   ├── api-contracts/            API wire types (error envelope, pagination, money, health)
│   ├── design-tokens/            Colour/spacing/type tokens; CSS variables for web, objects for mobile
│   ├── emails/                   Transactional email templates (HTML + text)
│   └── web-config/               Shared Next.js security headers
├── docs/
├── .github/workflows/ci.yml
├── docker-compose.yml            Local PostgreSQL + Redis
├── bunfig.toml                   Bun settings (hoisted linker for React Native)
├── biome.json · turbo.json · tsconfig.base.json · package.json
```

## Possible later additions

Add only when there is real code for them:

- `apps/operations-web`: only if the Operations PWA outgrows `console-web`.
- `apps/developer-docs`: public API docs site, generated from OpenAPI.
- `packages/ui`: shared React components, once two web apps need the same components.
- `packages/observability`: logging/tracing setup shared by api and worker.
- `packages/test-kit`: shared fixtures and helpers.
- `infrastructure/`: production Dockerfiles, environment config, Terraform once hosting is chosen.

## Backend module layout

```
modules/visitors/
├── domain/           entities, value-objects, policies, events, errors
├── application/      commands, queries, handlers, ports, dto
├── infrastructure/   persistence, providers, mappers
├── presentation/     http controllers, request/response schemas
└── visitors.module.ts
```

Do not create every folder for trivial modules.

## Frontend feature layout (web and mobile)

```
src/features/visitors/
├── api/  components/  hooks/  schemas/  types/
```

Shared UI stays separate from feature code. No global `utils` dumping ground.

## Dependency rules

| Workspace | May depend on |
| --------- | ------------- |
| `packages/domain` | nothing internal; no frameworks |
| `packages/db` | `domain` |
| `packages/api-contracts`, `design-tokens`, `emails`, `web-config` | nothing internal |
| `apps/api` | `domain`, `db`, `api-contracts` |
| `apps/worker` | `domain`, `db`, `emails` |
| `apps/console-web`, `apps/admin-web` | `domain` (value objects only), `api-contracts`, `design-tokens`, `web-config` |
| `apps/marketing-web` | `design-tokens`, `web-config` |
| `apps/resident-mobile` | `api-contracts`, `design-tokens` |

Client apps talk to the API over HTTP and never to the database. Business logic is never
duplicated in web or mobile.

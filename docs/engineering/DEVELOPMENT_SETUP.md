# Development Setup

## Prerequisites

| Tool    | Version | Notes |
| ------- | ------- | ----- |
| Bun     | 1.4.x   | Package manager and script runner (`npm i -g bun` or bun.sh) |
| Node.js | 24 LTS or newer | Runtime for API and worker |
| Docker  | Desktop / Engine with Compose | Local PostgreSQL and Redis |
| Flutter | stable  | Only for `apps/mobile` (not created yet) |

## First run

```powershell
bun install
Copy-Item .env.example .env
bun run services:up          # PostgreSQL 17 + Redis 7 via docker compose
bun run db:generate          # Prisma client
bun run db:migrate           # apply migrations (from Phase 2, when models exist)
bun run dev                  # web :3000, api :4000, worker health :4001
```

Useful URLs:

- Web: http://localhost:3000
- API liveness: http://localhost:4000/api/v1/health/live
- API readiness: http://localhost:4000/api/v1/health/ready (503 until Postgres and Redis are up)
- OpenAPI UI: http://localhost:4000/api/docs
- Worker readiness: http://localhost:4001/health/ready

## Everyday commands

| Command              | What it does |
| -------------------- | ------------ |
| `bun run lint`       | Biome lint + format check |
| `bun run lint:fix`   | Apply safe fixes and formatting |
| `bun run typecheck`  | Strict TypeScript across all packages |
| `bun run test`       | All Vitest suites |
| `bun run build`      | Build every package and app |

All of these must pass before a change is considered done. CI runs the same commands.

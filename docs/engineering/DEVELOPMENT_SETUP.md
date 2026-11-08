# Development Setup

## Prerequisites

| Tool | Version | Notes |
| ---- | ------- | ----- |
| Bun | 1.4.x | Package manager and script runner (`npm i -g bun` or bun.sh) |
| Node.js | 24 LTS or newer | Runtime for API, worker and Expo tooling |
| Docker | Desktop / Engine with Compose | Local PostgreSQL and Redis for `bun run dev`. **Not needed for tests**: integration tests start their own PostgreSQL |
| Expo Go | latest, on your phone | Run the resident app on a real device |
| Android Studio / Xcode | optional | Emulator (Windows/macOS) / iOS simulator (macOS only) |
| Visual C++ Redistributable (x64) | latest | **Windows only.** Required by native tools (Biome, Turborepo, Next.js SWC, Vitest). Without it they exit silently with code 53 / `0xC0000135`. Install: `winget install --id Microsoft.VCRedist.2015+.x64 -e` |

The checkout must be on an NTFS (or other link-capable) filesystem. Bun workspaces link
packages with symlinks, which exFAT and FAT32 drives do not support: `bun install` fails with
`EISDIR` there.

On slow or unstable connections Bun can stall while resolving. Limit parallel downloads:
`bun install --network-concurrency 8`.

## First run

```powershell
bun install
Copy-Item .env.example .env
bun run services:up          # PostgreSQL 17 + Redis 7 via docker compose
bun run db:generate          # Prisma client
bun run --cwd packages/db migrate:deploy   # apply migrations as veyra_owner
bun run dev                  # api :4000, worker :4001, console :3000
```

Prisma reads `.env` only from the package it runs in, so set `MIGRATION_DATABASE_URL` in the
shell (or in `packages/db/.env`, which is git-ignored) before migrating:
`$env:MIGRATION_DATABASE_URL = "postgresql://veyra_owner:veyra_owner_dev@localhost:5432/veyra"`.
Use `bun run db:migrate` (`prisma migrate dev`) only when authoring a new migration.

## Database roles

On first start with an empty volume, `docker compose` runs
`packages/db/sql/bootstrap-roles.sql` as the `postgres` superuser. It creates:

| Role | Password (dev only) | Used for |
| ---- | ------------------- | -------- |
| `veyra_owner` | `veyra_owner_dev` | Migrations (`MIGRATION_DATABASE_URL`). Owns the schema. |
| `veyra_app` | `veyra_app_dev` | API and worker (`DATABASE_URL`). Subject to row-level security. |
| `postgres` | `postgres` | Administration only. Never put it in `DATABASE_URL`: superusers bypass RLS. |

The init script runs only when the data volume is empty. If you started PostgreSQL before this
change (old `veyra`/`veyra` user), recreate the volume, which **deletes local data**:
`docker compose down -v; docker compose up -d`.

Details: [MULTI_TENANCY section 3](../architecture/MULTI_TENANCY.md).

## Running each app

| Command | App | URL |
| ------- | --- | --- |
| `bun run dev:api` | VEYRA API | http://localhost:4000/api/v1/health/live, docs at /api/docs |
| `bun run dev:worker` | VEYRA Worker | http://localhost:4001/health/ready |
| `bun run dev:console` | VEYRA Console | http://localhost:3000 |
| `bun run dev:marketing` | Public website | http://localhost:3001 |
| `bun run dev:admin` | Platform Admin | http://localhost:3002 |
| `bun run dev:mobile` | VEYRA Resident | Expo dev server; scan the QR code with Expo Go |

For the mobile app, set `EXPO_PUBLIC_API_BASE_URL` to your PC's LAN IP (e.g.
`http://192.168.1.10:4000/api/v1`), because a phone cannot reach `localhost` on your PC. Allow
port 4000 through Windows Firewall.

## Everyday commands

| Command | What it does |
| ------- | ------------ |
| `bun run lint` | Biome lint + format check |
| `bun run lint:fix` | Apply safe fixes and formatting |
| `bun run typecheck` | Strict TypeScript across all workspaces |
| `bun run test` | All unit and API Vitest suites (no database needed) |
| `bun run test:integration` | Database integration tests: starts a throwaway PostgreSQL 17 (embedded-postgres, no Docker), applies the real migrations as `veyra_owner`, tests RLS as `veyra_app`. PostgreSQL binaries come from `bun install` (no extra download) |
| `bun run build` | Build every package and web/backend app |

All of these must pass before a change is considered done. CI runs the same commands.

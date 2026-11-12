# Deployment runbook

VEYRA ships as one container image (the repository's `Dockerfile`) run as separate processes:
API, worker and console (and, for staff, the admin tool). PostgreSQL, Redis and S3-compatible
storage are managed services. `infra/compose/full-stack.yml` runs the same image and processes on
one machine; CI starts it on every pull request and walks a customer's first journey through it
(`infra/smoke/smoke.ts`).

## First time per environment

1. Create the database roles from the secrets manager: `packages/db/sql/production-roles.sql`
   (instructions at its top). Never reuse the development passwords.
2. Generate the keys, one set per environment, kept in the secrets manager:
   - `MFA_ENCRYPTION_KEY` (`openssl rand -base64 32`). Losing it means everyone sets up two-step
     sign-in again.
   - `WEBHOOK_SIGNING_KEY` (`openssl rand -base64 32`), the same value for the API and the worker.
3. Create the storage bucket with versioning on (see BACKUP_RESTORE.md).
4. Grant the first platform administrator (PLATFORM_ADMIN.md).

## Configuration

| Variable | Used by | Notes |
| -------- | ------- | ----- |
| `NODE_ENV=production` | all | Turns on JSON logs and MFA enforcement by default, refuses the sandbox payment gateway |
| `DATABASE_URL` | API, worker | `veyra_app` |
| `DATABASE_URL` (owner) | migrations only | `veyra_owner`, from the pipeline |
| `REDIS_URL` | API, worker | |
| `API_CORS_ORIGINS` | API | The console and admin tool origins |
| `CONSOLE_URL` | API | Links in account emails |
| `STORAGE_*` | API | ADR 0007 |
| `CLAMAV_HOST`, `CLAMAV_PORT` | API | Upload scanning; required before uploads are offered |
| `MFA_ENCRYPTION_KEY`, `MFA_ENFORCEMENT` | API | Leave enforcement at its production default |
| `WEBHOOK_SIGNING_KEY` | API, worker | |
| `LOG_LEVEL`, `LOG_FORMAT` | API | `json` by default in production |
| `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_STORAGE_ORIGIN` | console build | Baked into the image at build time (`--build-arg`) |

## Every release

1. CI is green on the commit (verify and smoke jobs).
2. Build the image with the environment's public addresses:
   `docker build --build-arg NEXT_PUBLIC_API_BASE_URL=... --build-arg NEXT_PUBLIC_STORAGE_ORIGIN=... -t veyra:<sha> .`
3. Take a database backup point (BACKUP_RESTORE.md) and note it in the release record.
4. Run migrations as the owner, once: `node /app/node_modules/prisma/build/index.js migrate deploy`
   (working directory `/app/packages/db`).
5. Roll out the worker, then the API, then the console; each must pass its readiness check
   (`/api/v1/health/ready`, worker `:4001/health/ready`, console `/sign-in`) before the old
   version stops.
6. Run the smoke test against the environment: `bun infra/smoke/smoke.ts <api> <console> <worker>`.

## Rollback

- **Application:** roll back to the previous image. Migrations are additive (new tables, columns,
  functions); the previous version keeps working against the newer schema.
- **A migration that must be undone:** never edit or delete a migration. Write a new forward
  migration that reverses it, test it in CI, and release it. Restoring a backup is the last
  resort and loses the writes made since the backup point.

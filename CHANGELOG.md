# Changelog

All notable changes to VEYRA are recorded here. Versions follow [Semantic Versioning](https://semver.org/);
`0.x` releases are pre-release and may change anything.

## [Unreleased]

### Changed

- Security reports now go to a private email address (GitHub private vulnerability reporting
  is not available for private repositories).

### Added

- `.gitattributes` normalising text files to LF line endings.

## [0.1.0] - 2026-11-08

First pre-release: product documentation and the monorepo foundation.

> **Not yet verified.** Dependencies have not been installed and no build or test has been run.
> See the Phase 1 blocker in [docs/product/ROADMAP.md](docs/product/ROADMAP.md).

### Added

- **Documentation**: product vision, PRD, roadmap, personas, user journeys, platform surfaces;
  architecture, data model, multi-tenancy, API design; security and privacy baseline, threat
  model, access control matrix; engineering standards, repository structure, development setup,
  testing strategy; ADRs 0001-0004; AI agent brief (`AGENTS.md`, `docs/AI_BUILD_PROMPT.md`).
- **`apps/api`**: NestJS API with validated configuration, `/api/v1` URI versioning, helmet,
  CORS allow-list, request IDs, a standard error envelope that hides internal details, a Zod
  validation pipe, liveness/readiness health checks for PostgreSQL and Redis, and OpenAPI docs.
- **`apps/worker`**: BullMQ worker with a job router that rejects tenant jobs without tenant
  context, plus a health endpoint.
- **`apps/console-web`**: Next.js management console shell.
- **`apps/resident-mobile`**: React Native + Expo resident app shell with an API status check.
- **`apps/marketing-web`**: public website home page.
- **`apps/admin-web`**: internal platform admin shell (never indexed).
- **`packages/domain`**: bigint-based `Money` with currency-aware parsing and lossless
  allocation, `TenantContext`, `JobEnvelope`, `DomainError`.
- **`packages/db`**: tenant transaction helper that sets `app.organisation_id` for
  PostgreSQL row-level security.
- **`packages/api-contracts`**, **`packages/design-tokens`**, **`packages/emails`** (invitation
  email), **`packages/web-config`** (shared security headers).
- Tests for all of the above (Vitest, Supertest), Docker Compose for PostgreSQL 17 and Redis 7,
  GitHub Actions CI with isolated database services, Biome, Turborepo, strict TypeScript.

### Known gaps

- `packages/db` Prisma schema and `createDbClient` are not written yet.
- No `bun.lock` yet, so CI will fail until dependencies are bootstrapped.
- No authentication, tenancy data model or business features yet (Phase 2 onwards).

[Unreleased]: https://github.com/saadmaz/Veyra/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/saadmaz/Veyra/releases/tag/v0.1.0

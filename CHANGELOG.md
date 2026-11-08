# Changelog

All notable changes to VEYRA are recorded here. Versions follow [Semantic Versioning](https://semver.org/);
`0.x` releases are pre-release and may change anything.

## [Unreleased]

### Changed

- Local PostgreSQL (docker compose) now runs as superuser `postgres` and bootstraps the
  VEYRA roles. `.env.example` uses `veyra_app` for `DATABASE_URL` and adds
  `MIGRATION_DATABASE_URL` (`veyra_owner`). Existing local volumes must be recreated.
- Vitest configs in `apps/api` and `packages/db` renamed to `.mts`.
- Security reports now go to a private email address (GitHub private vulnerability reporting
  is not available for private repositories).

- Biome no longer formats Markdown (it padded docs tables to unreadable widths); config
  migrated to Biome 2.6.
- Removed the one-time dependency bootstrap script: versions now live in `package.json` files
  and `bun.lock`.

### Added

- **Phase 2 tenancy and authorisation**: organisations (create, list mine, view, update),
  memberships (list, suspend, reactivate, revoke, last-admin guard), invitations (create with a
  one-time token, list, revoke, accept by matching email). Access-control module with a
  permission registry and system roles in code, a global permission guard (404 for
  non-members, 403 for missing permissions), anti-escalation, read-only suspended
  organisations and a startup check that every route declares `@Public()`, `@Authenticated()`
  or `@RequirePermission()`. See docs/security/ACCESS_CONTROL.md.
- Migration `20261108160000_invitation_token_lookup`: token-hash RLS lookup for invitations,
  one pending invitation per email and role, invitation outcome constraints.
- `isCountryCode` (ISO 3166-1 alpha-2) in `@veyra/domain`.
- **Phase 2 authentication** (`apps/api` identity module, ADR 0005): sign-up, sign-in, sign-out
  and current-session endpoints; argon2id passwords; opaque session tokens stored as SHA-256
  hashes, bound to web (httpOnly cookie) or mobile (bearer); idle and absolute expiry; Redis
  rate limits per IP and per email that fail closed; Origin check against CSRF and login CSRF;
  global deny-by-default guard with `@Public()`; audit events. See docs/security/AUTHENTICATION.md.
- `sessions.client` column (migration `20261108140000_session_client`).
- `@veyra/db/testing` (`startTestDatabase`), a migration drift test and time-zone tests; API
  integration tests against the real database; Redis rate-limiter tests in CI.
- `API_TRUST_PROXY` setting for the client IP behind proxies.
- **Phase 2 data foundation** (`packages/db`): Prisma models for users, password credentials,
  sessions, organisations, memberships, invitations, audit logs and outbox events; first
  migration with CHECK constraints, row-level security (ENABLE + FORCE) on tenant tables,
  request-context functions, an append-only audit-log trigger and least-privilege grants.
- Database roles `veyra_owner` (migrations) and `veyra_app` (application, no RLS bypass),
  created locally by `packages/db/sql/bootstrap-roles.sql`.
- `withTenantTransaction(..., { userId })` and `withUserTransaction` helpers.
- `bun run test:integration`: 24 integration tests against a real, throwaway PostgreSQL 17
  (embedded-postgres, no Docker), also run in CI.
- ADR 0005: built-in authentication behind a replaceable identity port.
- `.gitattributes` normalising text files to LF line endings.
- All dependencies installed and locked (`bun.lock`): NestJS 12, Next.js, React 19.3, Expo SDK
  58 / React Native 0.88, Prisma 7.10.1, TypeScript 7, Vitest 5, Biome 2.6.
- `packages/db`: Prisma 7 schema and config, `createDbClient()` (node-postgres driver adapter),
  package entry point, tests.
- Phase 1 verified locally: lint, typecheck, 65 tests and build pass in all 12 workspaces; the
  built API boots and serves health and OpenAPI endpoints.

### Fixed

- Timestamps read through Prisma were shifted by the database server's UTC offset when its
  time zone was not UTC (Prisma pg adapter). Application connections now pin `TimeZone=UTC`.
- Integration test teardown no longer fails on Windows when PostgreSQL briefly holds its data
  directory after stopping.
- `Money` used `Intl` display conventions for currency decimals, which reject valid amounts in
  currencies such as PKR (Intl: 0 decimals, ISO 4217: 2). It now uses the ISO 4217 table.

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

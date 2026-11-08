# Roadmap

| Phase | Deliverable                              | Status |
| ----- | ---------------------------------------- | ------ |
| 0     | Repository audit and discovery           | Done |
| 1     | Monorepo and engineering foundation      | Done, pending Docker-based verification (see below) |
| 2     | Identity and multi-tenancy               | Next |
| 3     | Organisation and property management     | |
| 4     | Resident and unit management             | |
| 5     | Visitor and access management            | |
| 6     | Finance and billing                      | |
| 7     | Maintenance and work orders              | |
| 8     | Facilities and reservations              | |
| 9     | Staff, vendors and assets                | |
| 10    | Communications and documents             | |
| 11    | Governance and incident management       | |
| 12    | Analytics and integrations               | |
| 13    | SaaS administration and subscriptions    | |
| 14    | Security hardening and commercial launch | |

## Phase 0 outcome

The repository started empty apart from the brief. Delivered: architecture, multi-tenancy,
access control, data model, API design, repository structure, ADRs 0001-0003.

## Phase 1 acceptance criteria

| # | Criterion | Status |
| - | --------- | ------ |
| 1 | Bun workspaces + Turborepo with `lint`, `typecheck`, `test`, `build` across all packages | Met |
| 2 | Strict shared TypeScript config | Met |
| 3 | `packages/domain` with bigint `Money`, `TenantContext`, `JobEnvelope`, `DomainError`, fully tested | Met |
| 4 | `packages/db` with Prisma schema, client factory and tenant transaction helper | Met |
| 5 | API: env validation, `/api/v1` versioning, helmet, CORS allow-list, request ids, error envelope, Zod validation pipe, health live/ready, OpenAPI | Met |
| 6 | Worker: BullMQ process, tenant-enforcing job router, health endpoint | Met |
| 7 | Web: Next.js app with design tokens and security headers, builds | Met |
| 8 | Docker Compose for PostgreSQL + Redis | Written, not run (Docker not installed on the dev machine) |
| 9 | CI workflow with isolated Postgres/Redis | Written, not yet run on GitHub |

## Phase 2 plan (Identity and multi-tenancy)

1. Choose the OIDC provider (candidates: Keycloak or Zitadel self-hosted; Auth0, WorkOS, Clerk managed). Needs decision.
2. Prisma models: User, ExternalIdentity, Organisation, Role, RolePermission, Membership, Invitation, AuditLog, OutboxEvent.
3. First migration with composite tenant FKs and RLS policies (raw SQL), application DB role without BYPASSRLS.
4. Auth guard (JWT validation via JWKS), tenant context resolution from route, permission guard,
   boot-time "every route declares a permission" check.
5. Integration test harness against real PostgreSQL; cross-tenant and expired-membership tests.
6. Rate limiting (Redis-backed) and structured JSON logging with request ids.

## Technical debt

- Structured logging (pino + OpenTelemetry) not yet added; Nest's default logger is in use.
- Rate limiting not yet enabled (Phase 2).
- `dev` scripts for api/worker build once and run; no watch mode yet.
- Module-boundary lint check to be added when the second business module exists.
- Worker `main.ts` (Redis wiring and health server) has no automated test; covered by the Phase 2 integration harness.
- `apps/mobile` not created (Flutter SDK not installed).

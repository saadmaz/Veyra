# Roadmap

Capability-based, not a promise of fixed dates. Estimate after discovery, technical spikes and
pilot access.

## Delivery stages and engineering phases

Stages are the product view; phases are the engineering increments that deliver them.

| Stage | Outcome | Engineering phases | Exit gate |
| ----- | ------- | ------------------ | --------- |
| 0. Discovery and product definition | Validated workflows, scope, pilot success criteria | 0 | Signed-off PRD, workflows, data map, risks, pilot acceptance criteria |
| 1. Engineering foundation | Secure, deployable platform skeleton | 1, 2 | Automated tests prove one organisation/property cannot access another's protected data |
| 2. Pilot MVP | First property runs selected daily workflows | 3, 4, 5, 6 (basic), 7, 10 (announcements) | Pilot users complete agreed journeys; reconciliation verified; security and recovery checks pass |
| 3. Operational depth | Facilities, parking, assets, workforce, vendors, documents, incidents | 8, 9, 10, 11 (incidents) | Release gates below |
| 4. Governance and enterprise controls | Committees, approvals, procurement, SSO, retention tooling, pen test, DR exercise | 11, 12 | Release gates below |
| 5. Global SaaS readiness | Localisation, regional adapters, data residency, subscriptions, entitlements, public API | 12, 13, 14 | Release gates below |
| 6. Intelligence and connected buildings | Permission-aware AI search, forecasting, anomaly detection, device integrations | after 14 | Release gates below |

## Engineering phases

| Phase | Deliverable                              | Status |
| ----- | ---------------------------------------- | ------ |
| 0     | Repository audit and discovery           | Architecture docs done; product discovery (Stage 0) outstanding |
| 1     | Monorepo and engineering foundation      | Code written; **not yet installed, built or tested** (see below) |
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

## Stage 0 discovery still required

- Interview management, finance, security, residents, maintenance and committee members.
- Map current processes and exceptions; inventory software, devices, payment channels, documents, data.
- Confirm the data controller/owner and who may administer the platform.
- Confirm pilot property structure, unit count, roles and permission matrix.
- Validate local legal, privacy and accounting requirements.
- Prioritise MVP journeys and agree acceptance criteria (see PRD section 5).
- Wireframes tested with real users; migration, support, training and rollout approach agreed.

## Phase 1 acceptance criteria

| # | Criterion | Status |
| - | --------- | ------ |
| 1 | Bun workspaces + Turborepo with `lint`, `typecheck`, `test`, `build` | Written, not run |
| 2 | Strict shared TypeScript config | Written, not run |
| 3 | `packages/domain`: bigint `Money`, `TenantContext`, `JobEnvelope`, `DomainError`, with tests | Written, not run |
| 4 | `packages/db`: tenant transaction helper with tests; Prisma schema and client factory | Helper and tests written; **Prisma schema and `createDbClient` not yet written** |
| 5 | API: env validation, `/api/v1`, helmet, CORS allow-list, request ids, error envelope, Zod pipe, health, OpenAPI, e2e tests | Written, not run |
| 6 | Worker: BullMQ process, tenant-enforcing job router, health endpoint, tests | Written, not run |
| 7 | Web apps (`console-web`, `marketing-web`, `admin-web`) with shared design tokens and security headers | Written, not run |
| 8 | Mobile app (`resident-mobile`, React Native + Expo) shell with API status check | Written, not run |
| 9 | Shared packages: `api-contracts`, `design-tokens`, `emails`, `web-config`, with tests | Written, not run |
| 10 | Docker Compose for PostgreSQL + Redis | Written, not run |
| 11 | CI workflow with isolated Postgres/Redis | Written; will fail until `bun.lock` is generated and committed |

**Blocker:** dependencies could not be installed because the development checkout is on an
exFAT drive, which cannot hold the symlinks Bun workspaces need. Move the repository to an NTFS
drive, run `bun run deps:bootstrap`, finish `packages/db`, and complete criteria 1-11.

## Phase 2 plan (Identity and multi-tenancy)

1. Choose the OIDC provider (candidates: Keycloak or Zitadel self-hosted; Auth0, WorkOS, Clerk managed). Needs decision.
2. Prisma models: User, ExternalIdentity, Organisation, Role, RolePermission, Membership, Invitation, AuditLog, OutboxEvent.
3. First migration with composite tenant FKs and RLS policies (raw SQL); application DB role without BYPASSRLS.
4. Auth guard (JWKS), tenant context from route, permission guard, boot-time "every route declares a permission" check.
5. Integration test harness against real PostgreSQL; cross-tenant and expired-membership tests.
6. Rate limiting (Redis-backed) and structured JSON logging with request ids.

## Release gates

No stage is complete on a feature demo alone. Each release requires: acceptance criteria met,
tests passing, security and permission review, migration and rollback plan, monitoring and
alerting, backup and restore validation appropriate to risk, documentation and support
readiness, user training and release communication, and known limitations documented.

## Technical debt

- Phase 1 not yet verified (see blocker above).
- `packages/db`: Prisma schema, `createDbClient` and `src/index.ts` still to be written once the Prisma version is installed.
- Structured logging (pino + OpenTelemetry) not yet added; Nest's default logger is in use.
- Rate limiting not yet enabled (Phase 2).
- `dev` scripts for api/worker build once and run; no watch mode yet.
- Module-boundary lint check to be added when the second business module exists.
- Worker `main.ts` (Redis wiring, health server) has no automated test; covered by the Phase 2 integration harness.
- `package.json` files carry no dependency versions until `scripts/install-dependencies.ps1` runs once.
- Worker does not yet send emails; `@veyra/emails` is ready for the Phase 2 invitation flow.
- No Content-Security-Policy yet on the web apps (added per app once script/style sources are known).
- Dependency and secret scanning not yet in CI.

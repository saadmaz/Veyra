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
| 1     | Monorepo and engineering foundation      | Done locally (lint, typecheck, 65 tests, build pass); CI and Docker pending (see below) |
| 2     | Identity and multi-tenancy               | In progress: Part 3 (data foundation) done; Part 4 (authentication) next |
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
Verified locally on 2026-11-08 (Windows 11, Bun 1.4.4, Node 26, TypeScript 7.0, Vitest 5.1).

| # | Criterion | Status |
| - | --------- | ------ |
| 1 | Bun workspaces + Turborepo with `lint`, `typecheck`, `test`, `build` | ✅ All pass across 12 workspaces |
| 2 | Strict shared TypeScript config | ✅ Typecheck clean |
| 3 | `packages/domain`: bigint `Money`, `TenantContext`, `JobEnvelope`, `DomainError` | ✅ 18 tests. Fixed: currency decimals now use ISO 4217 (PKR = 2), not `Intl` display rules |
| 4 | `packages/db`: Prisma 7 schema/config, `createDbClient`, tenant transaction helper | ✅ 5 tests; `prisma generate` and `validate` pass |
| 5 | API: env validation, `/api/v1`, helmet, CORS, request ids, error envelope, Zod pipe, health, OpenAPI | ✅ 18 tests; built API boots, live = 200, ready = 503 without a database (correct) |
| 6 | Worker: BullMQ process, tenant-enforcing job router, health endpoint | ✅ 6 tests |
| 7 | Web apps (`console-web`, `marketing-web`, `admin-web`) | ✅ 4 tests; all three `next build` successfully |
| 8 | Mobile app (`resident-mobile`, Expo SDK 58 / React Native 0.88) | ✅ 3 tests; typecheck clean. Not yet run on a device |
| 9 | Shared packages: `api-contracts`, `design-tokens`, `emails`, `web-config` | ✅ 11 tests |
| 10 | Docker Compose for PostgreSQL + Redis | ⏳ Not run (Docker not installed on the dev machine) |
| 11 | CI workflow with isolated Postgres/Redis | ⏳ First run happens on the PR that adds `bun.lock` |

## Phase 2 plan (Identity and multi-tenancy)

| Part | Scope | Status |
| ---- | ----- | ------ |
| 1-2 | Authentication decision: built-in auth behind an identity port ([ADR 0005](../adr/0005-built-in-authentication.md)) | ✅ Decided |
| 3 | Data foundation: User, PasswordCredential, Session, Organisation, Membership, Invitation, AuditLog, OutboxEvent; migration with CHECK constraints, RLS (ENABLE + FORCE), append-only audit trigger, least-privilege `veyra_app` role; tenant/user transaction helpers; embedded-PostgreSQL integration harness (24 tests) in CI | ✅ Done |
| 4 | Authentication: sign-up, sign-in, sign-out, sessions (hashed opaque token, idle + absolute expiry, revocation), argon2id, cookie (web) / bearer (mobile), Redis rate limiting, audit events, auth guard | Next |
| 5 | Tenancy and authorisation: create organisation, memberships, invitations (SECURITY DEFINER token lookup), role/permission registry in code, permission guard with boot-time "every route declares a permission" check, cross-tenant and expired-membership API tests | |
| 6 | Console UI: sign-in, sign-up, organisation switcher | |

Also in Phase 2: structured JSON logging with request ids.

## Release gates

No stage is complete on a feature demo alone. Each release requires: acceptance criteria met,
tests passing, security and permission review, migration and rollback plan, monitoring and
alerting, backup and restore validation appropriate to risk, documentation and support
readiness, user training and release communication, and known limitations documented.

## Technical debt

- Docker Compose and the API's real database/Redis readiness path not yet exercised locally.
- Mobile app not yet launched on a device or emulator.
- `bunfig.toml` uses the hoisted linker for React Native; revisit if Bun's isolated linker gains Metro support.
- Structured logging (pino + OpenTelemetry) not yet added; Nest's default logger is in use.
- Rate limiting not yet enabled (Phase 2, Part 4).
- Built-in auth lacks MFA, email verification, password reset and breached-password checks
  (ADR 0005); required before privileged customer users go live.
- CI still starts a PostgreSQL service container that no test uses (integration tests use
  embedded-postgres); keep or remove when the API integration tests land in Part 4.
- Production database role provisioning (veyra_owner / veyra_app from a secrets manager) not yet
  scripted.
- `dev` scripts for api/worker build once and run; no watch mode yet.
- Module-boundary lint check to be added when the second business module exists.
- Worker `main.ts` (Redis wiring, health server) has no automated test; covered by the Phase 2 integration harness.
- Worker does not yet send emails; `@veyra/emails` is ready for the Phase 2 invitation flow.
- No Content-Security-Policy yet on the web apps (added per app once script/style sources are known).
- Dependency and secret scanning not yet in CI.

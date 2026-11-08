# Testing Strategy

| Level       | Tooling | Scope | Where |
| ----------- | ------- | ----- | ----- |
| Unit        | Vitest | Domain rules, value objects, pure services | `packages/*/test`, `apps/*/test` |
| Integration | Vitest + real PostgreSQL 17 (embedded-postgres, started per run) | Migrations, roles, RLS policies, constraints, repositories | `packages/db/test/integration/*.int.test.ts` (`bun run test:integration`); API repositories and queues from Part 4 |
| API / e2e   | Vitest + Supertest against the real Nest pipeline | HTTP contract, error envelope, guards | `apps/api/test/*.e2e.test.ts` |
| Contract    | Recorded provider fixtures + schema checks | Payment, SMS, email adapters | per adapter (from Phase 6) |
| Web UI e2e  | Playwright | Critical user journeys in the browser | `apps/console-web/e2e` (from Phase 3) |
| Mobile components | jest-expo + React Native Testing Library | Screens and components | `apps/resident-mobile` (when real screens exist) |
| Mobile device e2e | Maestro | Critical resident journeys on emulator/device | `apps/resident-mobile/e2e` (from Phase 4) |

## Rules

- The e2e tests use `configureApp()` from `bootstrap.ts`, the same function production uses,
  so the tested pipeline is the real one.
- Integration tests never run against shared or production databases. Each run starts its
  own throwaway PostgreSQL (real binaries via `embedded-postgres`, a random free port, a temp
  data directory deleted afterwards), runs `packages/db/sql/bootstrap-roles.sql` and the real
  Prisma migrations, then tests as the same restricted role the API uses. This works the same
  on Windows, macOS and the Linux CI runner, without Docker.
- Integration test files run sequentially against one database; each test creates its own
  uniquely identified fixtures.
- Tests do not hit real external providers. Adapters are tested against fixtures, and one
  opt-in smoke suite runs against provider sandboxes.
- A failing test is fixed or the change is reverted. Tests are never skipped to get green.

## Current coverage (Phase 1: 65 tests across 12 workspaces, all passing on 2026-11-08)

- `packages/domain`: Money arithmetic, parsing, allocation, precision, currency safety; tenant
  context and job envelope validation.
- `packages/db`: tenant transaction helper sets `app.organisation_id` as a bound parameter
  before work and refuses invalid tenants.
- `apps/api`: env validation; health live/ready (incl. 503 on dependency failure); request id;
  error envelope for 404 / validation / domain / unknown errors with no internal leakage;
  security headers; CORS allow-list; OpenAPI document.
- `apps/worker`: job routing with mandatory tenant context and platform-job declarations.
- `apps/console-web`, `apps/admin-web`, `apps/marketing-web`: shared security headers applied;
  admin is non-indexable, marketing stays indexable.
- `apps/resident-mobile`: API status client (online / degraded / offline handling).
- `packages/web-config`: baseline security headers and no-index headers.
- `packages/design-tokens`: light/dark token parity, valid colours, CSS variable output.
- `packages/emails`: invitation email content, HTML escaping, HTTPS-only links.

## Phase 2 database integration tests (`packages/db`, 24 tests)

- Roles: `veyra_app` is not a superuser, cannot bypass RLS and cannot read the migrations table.
- No context: nothing is visible, including to the schema owner (FORCE RLS).
- Tenant context: sees only its own organisation, memberships, invitations and audit records;
  cannot insert into, update, or move rows into another tenant; cannot delete organisations.
- User context: lists only organisations with an active membership; sees only own memberships;
  loses access when a membership is suspended.
- Pooled connections: context does not leak into the next transaction.
- Audit log: platform events hidden from tenants; cross-tenant writes rejected; updates and
  deletes rejected for the app role, the owner and a superuser.
- Constraints: normalised emails; organisation-scoped memberships must match their organisation.
- The generated Prisma client with `withTenantTransaction` gets the same isolation.

## Critical scenarios to add as features land

Cross-tenant access, unauthorised financial access, expired memberships, duplicate payment
callbacks, invalid visitor passes, concurrent facility bookings, failed notifications,
transaction failures, permission changes during sessions, tenant export and deletion.

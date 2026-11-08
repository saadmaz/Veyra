# Testing Strategy

| Level       | Tooling | Scope | Where |
| ----------- | ------- | ----- | ----- |
| Unit        | Vitest | Domain rules, value objects, pure services | `packages/*/test`, `apps/*/test` |
| Integration | Vitest + real PostgreSQL 17 (embedded-postgres, started per run); real Redis in CI | Migrations, drift, roles, RLS, constraints, time zones; full API flows over HTTP against the real database | `packages/db/test/integration`, `apps/api/test/integration` (`bun run test:integration`) |
| API / e2e   | Vitest + Supertest against the real Nest pipeline | HTTP contract, error envelope, guards | `apps/api/test/*.e2e.test.ts` |
| Contract    | Recorded provider fixtures + schema checks | Payment, SMS, email adapters | per adapter (from Phase 6) |
| Web UI e2e  | Playwright (Chromium, desktop and phone viewports) + axe-core | Critical user journeys, WCAG 2.2 AA automated checks, no horizontal scroll on phones | `apps/console-web/e2e` (`bun run test:e2e`, after `bun run build`) |
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
- The test database server runs in a deliberately non-UTC time zone (`Pacific/Chatham`) on every
  machine, so time-zone bugs fail locally and in UTC CI runners alike.
- Shared setup: `startTestDatabase()` from `@veyra/db/testing` (test-only export).
- The Redis rate-limiter suite needs `REDIS_URL`. CI sets it (Redis service container) and runs
  it; on a machine without Redis it is reported as **skipped**, never as passed.
- A drift test fails if `schema.prisma` and the migrations describe different databases.
- Tests do not hit real external providers. Adapters are tested against fixtures, and one
  opt-in smoke suite runs against provider sandboxes.
- A failing test is fixed or the change is reverted. Tests are never skipped to get green.

## Phase 1 coverage (65 unit tests across 12 workspaces, all passing on 2026-11-08)

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

## Phase 2 integration tests

### `packages/db` (28 tests)

- Migrations: the migrated database matches `schema.prisma` exactly (drift check).
- Time zones: the server runs non-UTC; Prisma reads and writes the correct instants.

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

### `apps/api` authentication (19 tests, plus 5 Redis tests in CI)

- Deny by default: protected routes return 401 without, or with garbage, credentials; health stays public.
- Web sign-up: httpOnly SameSite=Lax cookie, no token in body, `no-store`; only argon2id and
  SHA-256 hashes stored; case-insensitive duplicate email -> 409; concurrent duplicate sign-ups
  create exactly one account; validation errors never echo the password.
- Sign-in: same 401 for wrong password and unknown email; 429 + Retry-After after 5 failures even
  with the right password; disabled users lose sign-in and existing sessions.
- Mobile: bearer token in body, no cookie; tokens rejected on the other transport.
- Sign-out revokes server-side (old cookie replay fails); idle and absolute expiry enforced.
- CSRF: cross-origin state changes and forged sign-ins return 403.
- Audit: sign-up, failed sign-in (with reason), sign-in and sign-out recorded, without secrets.
- Redis limiter: counting, fixed window, expiry, reset, atomicity under 50 concurrent hits.

### `apps/api` identity unit tests (41 tests)

Token format and hashing; session lifetimes, sliding idle expiry capped by the absolute expiry;
input normalisation and password policy (Unicode length, NFKC, bounds); argon2id parameters,
verification, malformed hashes, rehash detection; service rules with fakes (rate limits per IP
and per email, fail-closed limiter, timing equalisation, disabled accounts, transport binding,
expiry, rehash on sign-in, idempotent sign-out).

### Part 5: tenancy and authorisation

- `apps/api` integration (18): organisation creation makes the creator admin; slug conflicts and
  input validation; **every organisation route returns 404 to non-members**; unknown and
  malformed ids behave like foreign ones; finance officer gets 403 on members, settings and
  invitations; suspension, reactivation and revocation apply on the next request; revoked is
  final; expired and future-dated memberships denied; last admin protected; suspended
  organisation read-only; invitation tokens shown once; email-bound, single-use acceptance
  (concurrent attempts: one wins); unknown, revoked, expired and duplicate invitations; no
  revoking another organisation's invitation; tenant audit trail; keyset pagination.
- `apps/api` unit (32): permission registry consistency, grant validity windows (inclusive
  start, exclusive end), downward-only scope, unknown roles grant nothing, suspended/archived
  organisations, anti-escalation, organisation and invitation input rules, membership
  transitions, startup route-access check (undeclared route, unknown permission, missing
  `:organisationId`).
- `packages/db` integration (6): invitation token-hash RLS lookup exposes exactly one row and
  grants no writes; malformed hashes rejected; one pending invitation per email and role;
  accepted/revoked exclusive.

### Part 6: console

- `apps/console-web` unit (21): API client (credentials, error envelope, network errors, 204,
  refuses off-host paths), error messages never echo 5xx text, open-redirect protection for
  `?next=`, invitation tokens only in the URL fragment, slug suggestion.
- `apps/console-web` e2e (Playwright, each journey at desktop and phone size): sign-in redirect
  and return; wrong-password alert; off-site `next` ignored; sign-up with password feedback,
  empty state, create organisation; invite, open link signed-out, sign in, accept, finance
  officer sees no member management; email mismatch; malformed link makes no API call; not-found
  organisation; unreachable API with retry; sign-out protects pages; skip link. axe WCAG 2.2 AA
  scans on each screen. The API is a contract-following fake (`e2e/fake-api.ts`): these tests
  prove the console, not the API.

## Critical scenarios to add as features land

Cross-tenant access, unauthorised financial access, expired memberships, duplicate payment
callbacks, invalid visitor passes, concurrent facility bookings, failed notifications,
transaction failures, permission changes during sessions, tenant export and deletion.

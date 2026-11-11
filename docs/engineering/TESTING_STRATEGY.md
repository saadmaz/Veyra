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

## Phase 3 tests

### Part 1: property structure (`packages/db` integration, 26)

- No tenant context sees nothing in any structure table; a tenant sees only its own rows even
  when codes collide with another tenant's; cross-tenant writes and deletes rejected.
- Composite foreign keys: building to another tenant's property, floor to another property's
  building, unit to another property's building or another building's floor, floor without a
  building: all rejected. Properties cannot move between tenants.
- Unit numbers unique per building (case-insensitive) and per property for building-less units;
  code formats; archive consistency; positive areas; floor level range.
- Membership and invitation scopes must name a property, building or unit of the same
  organisation.
- Prisma reads the nested structure inside tenant context and nothing outside it.

### Part 2: property-scoped access

- `apps/api` integration (18): property defaults from the organisation, per-organisation codes,
  validation, creation limited to admins, audit; a property manager of P1 is a member with only
  the baseline organisation permission, sees only P1 in lists, gets 404 on P2 and on other
  organisations' properties by either path, loses and regains access with suspension; a
  finance officer sees every property of the organisation only; non-members get 404 on all
  property routes; property-scoped invitations, role/scope mismatch (422), foreign property
  (404), pending invitations per scope.
- `apps/api` unit: downward-only coverage (organisation grant covers all properties, property
  grant only its own, building grants not the property), no upward reach, archived property
  read-only, list filtering, anti-escalation at the target scope, startup check for
  `:propertyId`.

### Part 3: structure API

- `apps/api` integration (15): property manager builds and edits their property but cannot
  activate or archive it; finance officer reads only; another property's manager and outsiders
  get 404; per-property building codes, per-building floor levels, unit numbers per building
  and per property (case-insensitive); exact decimals returned as strings and JSON numbers
  rejected; another building's floor or another property's building refused; filtering;
  archive refused while units are active, then cascades to floors; nothing created under an
  archived parent; create-versus-archive race (5 rounds) never leaves an active unit in an
  archived building; country/currency only while onboarding; property archive cascades and
  freezes writes while reads continue.
- The race test checks outcomes, not timing: the guarantee comes from the row locks
  (share on the parent when creating, update on the row when archiving), and the test cannot
  force the bad interleaving every run.
- `apps/api` unit (20): decimal strings (bounds, scale, no JSON numbers), floor requires
  building, code normalisation, at-least-one-field updates, default list status.

### Part 4: property console

- `apps/console-web` e2e (5 journeys, each at desktop and phone size): admin adds a property,
  a building, a floor and a unit (area shown as an exact decimal), sees the archive refused
  while units are active, activates the property; admin invites a property manager for one
  property; archiving a property after confirmation removes every change control; a property
  manager sees only their property, no lifecycle or invitation controls, and "not found" for
  another property; a finance officer reads the structure with no change controls. axe WCAG 2.2
  AA checks on the new pages; no horizontal scroll on phones.
- The fake API (`e2e/fake-api.ts`) mirrors the API's per-scope permissions and archive rules.

## Phase 4 tests

### Part 1: resident data (`packages/db` integration, 22)

- No tenant context sees nothing in any resident table; tenants see only their own people;
  ownerships cannot point at another tenant's unit or person.
- Shares: sole owner and exact thirds accepted; sums other than one rejected at commit; a
  transfer in one transaction accepted; an overlapping transfer rejected; same person cannot
  overlap on a unit; invalid fractions rejected; voided rows ignored and need a reason; no
  deletes.
- Tenancies: one per unit at a time with inclusive end dates (sharing a last day overlaps);
  voided tenancies free the period; at most one primary tenant; end before start rejected.
- Household periods cannot overlap; people validated (unique email per organisation, E.164,
  language tag); emergency contacts deletable; active plates unique per property.

### Part 2: resident access

- `apps/api` integration (13): resident invitations link profiles (email-bound, RESIDENT role);
  an owner is a member with the baseline permission, sees only their unit and its residents
  (names only), gets 404 on other units, the property and other organisations, 403 on member
  lists; a household member sees the unit but not the residents; tenancies count from the first
  **local** day and stop after the last; future and past records grant nothing; ending, voiding
  or archiving takes effect on the next request; staff see residents, finance officers do not;
  invitation edge cases (no email, already linked, wrong account, derived roles not invitable).
- The property's time zone is chosen so its local date differs from the UTC date at test time
  (Kiritimati from 10:00 UTC, Pago Pago before), so a UTC-based date rule would fail.
- `apps/api` unit (+7): unit scope coverage (own unit only; staff through property or
  organisation), household without residents list, finance without names, derived roles never
  assignable, archived property read-only, startup check for `:unitId`.

### Part 3: staff residents API

- `apps/api` integration (16): profiles with normalised contact data; duplicate email; people
  of another property hidden from its manager (404) while admins use the directory; finance
  officers see no contact details; emergency contacts; first owner then transfer to co-owners
  (old ownership ends the day before); shares not adding up (400) and history rewrites (409);
  voiding one co-owner refused by the database's commit-time check and reported as 409,
  voiding both allowed; move-in, overlap, move-out, end before start, voiding; household
  overlap, end and void; plates normalised, unique per property, freed on archive; archiving
  refused for units with current or future records and for properties with occupied units;
  changes refused on archived units; resident list per property; another property's manager
  and outsiders get 404.
- `apps/api` unit (+9): exact share sums (thirds, millionths), set-owners validation, real
  calendar dates, day-before across month/year/leap boundaries, inclusive overlap, primary
  tenant rule, phone/email/plate normalisation.

### Part 4: resident console

- `apps/console-web` unit (+9, `test/residents.test.ts`): share parsing ("1", "1/2", rejects
  decimals, percentages and shares above the whole), exact share sums with BigInt (thirds,
  millionths), today in the property's time zone across a year boundary (Karachi vs New York),
  calendar dates formatted without time-zone shifts, inclusive period status (current, ended,
  upcoming, voided), ownership changes grouped by start date.
- `apps/api` integration (+1): the people picker offers the property's own and unattached
  profiles, not another property's residents, and filters by name or email.
- `apps/console-web` browser journeys (+9, desktop and phone, axe WCAG 2.2 AA, no horizontal
  scroll), `e2e/residents.spec.ts`:
  - Admin records two owners (a 1/2 + 1/3 split is refused in the browser before any request),
    a tenant, a household member and a vehicle; the property's resident list shows each role.
  - Admin edits a profile, adds and removes an emergency contact (DELETE), and creates an app
    invitation link.
  - Admin records a move-out (inclusive end date), voids a tenancy and an ownership change with a
    reason, and sees the API's refusal of a backdated transfer (`OWNERSHIP_CONFLICT`).
  - A property manager manages residents of their property and gets "not found" for another
    property's unit.
  - A finance officer sees unit details but no resident data, and the console never requests
    resident endpoints for them (asserted on the request log, not only on what is shown).
  - An archived unit shows its records with no change controls.
  - The people picker offers an unattached profile but not another property's resident.
  - An owner finds their unit under "Your homes", sees who lives there and no staff controls; a
    household member sees the unit but not the list of residents.
- `e2e/fake-api.ts` mirrors the resident endpoints, permissions and conflict codes. Its request
  shapes were checked once against the real API (local PostgreSQL and Redis, 2026-11-11); an
  automated full-stack smoke test is still outstanding.

## Phase 5 tests

### Part 1: visitor data (`packages/db` integration, 20)

- No tenant context sees nothing in any visitor table; one tenant cannot see another's
  invitations; invitations for another tenant's unit, passes filed under another property and
  visits claiming another unit's invitation are rejected by composite keys; an invitation link
  without a unit is refused.
- Invitations: window order and 31-day limit, 1-50 entries, E.164 phone, trimmed name;
  revocation is final; an invitation cannot move to another unit.
- Passes: only SHA-256 hex hashes; one live pass per invitation and one live code per property
  (both freed by revoking); a pass can only be revoked, once.
- Online admission backstop: entries counted (denials do not count); outside the window,
  revoked invitations and revoked passes refused; backdated online admissions refused while
  PAPER and OFFLINE_SYNC records are stored as they happened; two concurrent admissions for the
  last entry: exactly one succeeds.
- Visits: denial needs a reason and never departs; the departure is recorded once and nothing
  else changes; the application cannot delete visits.
- Access events: UPDATE and DELETE refused for the application and for the superuser.
- The migration drift test confirms the migrated database matches `schema.prisma`.

## Critical scenarios to add as features land

Cross-tenant access, unauthorised financial access, expired memberships, duplicate payment
callbacks, invalid visitor passes, concurrent facility bookings, failed notifications,
transaction failures, permission changes during sessions, tenant export and deletion.

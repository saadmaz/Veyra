# Changelog

All notable changes to VEYRA are recorded here. Versions follow [Semantic Versioning](https://semver.org/);
`0.x` releases are pre-release and may change anything.

## [Unreleased]

### Changed

- Fixed an intermittent API integration test (membership valid from the database's `now()`
  checked against the API's clock, which can differ by milliseconds on Windows).
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

- **Phase 6 billing** (migration `20261112120000_billing`): finance permissions
  (`property.finance.read` for property managers, `property.finance.manage` for finance officers
  and organisation admins); per-property finance set-up with a default chart of accounts and the
  `SERVICE` (owners) and `UTILITIES` (occupant) charge types; charge types; recurring charges
  (flat or per square metre, for one unit or every unit, by month); billing runs that create one
  invoice per unit and party, report what they cannot bill and never bill a recurring charge twice
  for a month; one-off invoices; issuing posts the invoice to the ledger (receivables and income)
  in the same transaction and numbers it; drafts can be discarded; issued invoices never change.
  19 database, 7 unit and 15 API integration tests.
- **Phase 6 ledger foundation** (migration `20261112090000_ledger`): a double-entry ledger per
  property in the property's currency, with amounts as integer minor units. Ledger accounts
  (archived, never deleted; optional system keys), accounting periods (no overlaps, at most a
  year; postings only into an open period), journal entries and lines. Entries are created as
  drafts and posted in a separate step. Posting checks balance, open period, active accounts,
  currency and property, then assigns the next entry number of the property with no gaps.
  Posted entries and their lines never change, not even for the superuser or the schema owner;
  mistakes are corrected by a reversal that mirrors the original, at most once. A property's
  currency is fixed once it has ledger entries. 31 database integration tests. Roadmap: the
  Phase 6 plan and the owner's finance decisions.
- **Phase 5 offline gate and paper log** (migration `20261111180000_offline_gate`): the gate
  screen keeps working when the connection drops, checking passes against a 4-hour list of
  hashes and queuing admissions, refusals, walk-ins to the property and departures on the device;
  they are sent when the connection returns, recorded at the time they happened, once per device
  reference, and flagged when the pass would not have allowed them. Supervisors type in the paper
  log and review flagged entries ("Needs review"). Gate procedure in
  `docs/operations/GATE_OFFLINE.md`.
- **Phase 5 visitor console**: on the unit page residents and staff register visitors and get
  the pass once (QR code and reference code), list and cancel them; residents answer walk-in
  requests (checked every 5 seconds). Gate screen for security staff: check a pass by code or
  camera scan, admit or refuse, walk-in requests with approval, departures. Visit log and
  expected visitors for supervisors. Installable web app manifest; camera allowed on the gate
  route only. Unit detail now includes `propertyTimeZone`. New dependency `qrcode-generator`
  (MIT, no dependencies) to draw QR codes.
- **Phase 5 walk-in approval** (migration `20261111150000_walk_in_requests`): guards request
  entry for someone without a pass; a resident of the unit (not staff) approves or denies in the
  app within 10 minutes; an approval admits once within 15 minutes; at most five open requests
  per unit. The database refuses decisions after expiry and any online admission to a unit
  without an invitation or a fresh, unused approval. Polling endpoints for the gate and the app.
- **Phase 5 visitor API and security roles**: `SECURITY_GUARD` and `SECURITY_SUPERVISOR`
  (property-scoped) and permissions `unit.visitor.invite`, `property.visitor.check_in`,
  `property.visitor.read`, `property.visitor.manage`; owners, tenants, household members and
  staff register visitors and receive the pass once (QR token and reference code, stored as
  hashes); guards validate (minimal data, rate limited), admit (re-checked under a row lock),
  deny, record walk-ins to the property and departures; supervisors read the visit log and
  revoke invitations; a pass stops working when its host no longer lives at the unit. Phone
  and plate validation moved to shared schemas.
- **Phase 5 visitor data foundation** (migration `20261111120000_visitors`): visitor
  invitations (unit, category, name, optional phone and plate, time window, entries), passes
  stored as SHA-256 hashes of a QR token and a reference code, visits (admitted or denied, gate,
  departure, source ONLINE / PAPER / OFFLINE_SYNC) and append-only access events; online
  admission backstop with a row lock so two gates cannot both use the last entry; immutable
  visits; revocation final; row-level security and no DELETE grants.
- **Phase 4 resident console**: unit page (details for every staff role; owners with exact
  fractional shares and transfers, tenancies with move-in and move-out, household members,
  vehicles, voiding with a reason); property resident list; resident page (profile editing,
  records at the property, emergency contacts, app invitation link); unit numbers link to the
  unit page from the property and building pages; "Your homes" and a "Who lives here" view for
  residents; people picker endpoint `GET …/properties/:id/persons` (the property's people and
  unattached profiles). API client gains `DELETE`. Browser journeys
  for admin, property manager, finance officer and archived units.
- **Phase 4 staff residents API**: resident profiles (property-scoped visibility and an
  organisation directory), set owners from a date (first owner or transfer) with exact share
  validation, voiding, tenancies with move-in/move-out, household members, vehicles, emergency
  contacts; archiving units and properties refused while occupied
  (`app_unit_is_occupied`, migration `20261109210000_unit_occupancy`); permissions
  `organisation.resident.read`, `property.resident.read`, `property.resident.manage`;
  `databaseErrorCode` helper so database rule violations surface as 409.
- **Phase 4 resident access**: unit-scoped permissions (`unit.*` at `:unitId`); derived
  OWNER, TENANT and HOUSEHOLD_MEMBER roles computed from records effective today in the
  property's time zone (`app_resident_grants`), never assignable; resident invitations linking a
  profile to a login; `my-units`, unit detail and current residents endpoints; resident
  organisations listed under "my organisations" (migration `20261109180000_resident_access`).
- **Phase 4 resident data foundation** (migration `20261109150000_residents`): persons
  (resident profiles), ownerships with exact fractional shares that must sum to one at every
  date (deferred check), tenancies with occupants, household members, emergency contacts and
  vehicles; inclusive date periods, overlap exclusion constraints (`btree_gist`), voiding instead
  of deleting, row-level security.
- **Phase 3 console**: properties on the organisation page, add-property form, property page
  (overview, activate and archive with confirmation, buildings, units, common areas, invite a
  property manager), building page (floors and units); controls shown per permission.
  `GET …/buildings/{id}` API endpoint.

### Security

- Sign-in and sign-up forms use `method="post"`, so a submission before scripts load can never
  put credentials into the URL.
- **Phase 3 structure API**: property settings, activation and archiving (cascading to the
  whole structure); buildings, floors, units and common areas with create, update, archive and
  list endpoints; archive rules (no active units), parent checks, unique-rule conflicts mapped to
  stable codes, race-safe row locking, audit for every change; unit area and share ratio as
  decimal strings. New permissions `property.settings.manage`, `property.lifecycle.manage`,
  `property.structure.read`, `property.structure.manage`.
- **Phase 3 property access**: property-scoped permissions (`property.*`, evaluated at the
  route's `:propertyId`) with downward-only inheritance; `PROPERTY_MANAGER` role; finance
  officers grantable per property; property create, list (filtered to reachable properties)
  and view endpoints; property-scoped invitations (`propertyId`, `scopeType`/`scopeId` in
  responses); anti-escalation evaluated at the target scope; every member may read the
  organisation's basic profile. Pending-invitation uniqueness is now per scope.
- **Phase 3 data foundation**: properties, buildings, floors, units and common areas with
  composite tenant foreign keys, row-level security, archive-only lifecycle, case-insensitive
  unit numbering (including building-less villas), and a trigger that keeps membership and
  invitation scopes inside their organisation (migration `20261109090000_property_structure`).
- **Phase 2 console** (`apps/console-web`): sign-in, sign-up, organisations list with switcher,
  create organisation, organisation overview with members and invitations (one-time link with
  copy), invitation acceptance; loading, empty, error, permission and success states; skip link,
  labelled fields with linked errors, live regions, phone layouts. Browser calls the API with its
  session cookie (ADR 0006).
- Playwright browser tests with axe WCAG 2.2 AA checks, in CI (`bun run test:e2e`).
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

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
| 1     | Monorepo and engineering foundation      | Done (CI green; Docker Compose verified locally 2026-11-11) |
| 2     | Identity and multi-tenancy               | Done. Exit review: [PHASE_2_REVIEW](../reviews/PHASE_2_REVIEW.md) |
| 3     | Organisation and property management     | Done. Exit review: [PHASE_3_REVIEW](../reviews/PHASE_3_REVIEW.md) |
| 4     | Resident and unit management             | Done. Exit review: [PHASE_4_REVIEW](../reviews/PHASE_4_REVIEW.md) |
| 5     | Visitor and access management            | In progress: Part 1 (data foundation) done |
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
| 10 | Docker Compose for PostgreSQL + Redis | ✅ Verified 2026-11-11 (Docker Desktop, Node 24): both healthy, roles bootstrapped, migrations applied as `veyra_owner`, API readiness reports database and Redis up, worker ready |
| 11 | CI workflow with isolated Postgres/Redis | ✅ Green on every PR since #4; required to merge |

## Phase 2 plan (Identity and multi-tenancy)

| Part | Scope | Status |
| ---- | ----- | ------ |
| 1-2 | Authentication decision: built-in auth behind an identity port ([ADR 0005](../adr/0005-built-in-authentication.md)) | ✅ Decided |
| 3 | Data foundation: User, PasswordCredential, Session, Organisation, Membership, Invitation, AuditLog, OutboxEvent; migration with CHECK constraints, RLS (ENABLE + FORCE), append-only audit trigger, least-privilege `veyra_app` role; tenant/user transaction helpers; embedded-PostgreSQL integration harness (24 tests) in CI | ✅ Done |
| 4 | Authentication: sign-up, sign-in, sign-out, sessions (hashed opaque token, idle + absolute expiry, revocation, transport binding), argon2id, cookie (web) / bearer (mobile), Redis rate limiting, Origin check, audit events, global deny-by-default guard ([AUTHENTICATION](../security/AUTHENTICATION.md)) | ✅ Done |
| 5 | Tenancy and authorisation: create organisation, memberships (suspend/reactivate/revoke, last-admin guard), invitations (token-hash RLS lookup), role/permission registry in code, permission guard, startup check that every route declares its access, anti-escalation, cross-tenant and expired-membership API tests ([ACCESS_CONTROL](../security/ACCESS_CONTROL.md)) | ✅ Done |
| 6 | Console UI: sign-in, sign-up, organisations list and switcher, create organisation, organisation overview with members and invitations, invitation acceptance; Playwright journeys with axe WCAG 2.2 AA checks ([ADR 0006](../adr/0006-console-calls-api-from-browser.md)) | ✅ Done |

Also in Phase 2: structured JSON logging with request ids.

## Phase 3 plan (Organisation and property management)

| Part | Scope | Status |
| ---- | ----- | ------ |
| 1 | Data foundation: properties, buildings, floors, units, common areas; composite tenant foreign keys; RLS; archive-only; unit-number rules; membership/invitation scope trigger; database tests | ✅ Done |
| 2 | Property-scoped roles (property manager) with downward-only scope inheritance; property create, list (filtered) and view; property-scoped invitations; cross-property isolation tests | ✅ Done |
| 3 | API: property settings and lifecycle (activate, archive with cascade); buildings, floors, units and common areas with archive rules, parent checks and race-safe locking | ✅ Done |
| 4 | Console: properties on the organisation page, add property, property page (overview, activate/archive, buildings, units, common areas, invite a property manager), building page (floors, units); browser journeys per role | ✅ Done |

Deferred from Phase 2 and tracked in [PHASE_2_REVIEW](../reviews/PHASE_2_REVIEW.md): MFA, email
verification, password reset, structured logging, secret scanning, console CSP, production roles
and backups, full-stack smoke test (all before a pilot stores real data).

## Phase 4 plan (Resident and unit management)

Decisions (owner, 2026-11-09): personal data limited to name, email, phone and language;
ownership shares as exact fractions; the resident mobile app comes after Phase 4.

| Part | Scope | Status |
| ---- | ----- | ------ |
| 1 | Data foundation: persons, ownerships (exact shares summing to 1, deferred check), tenancies with occupants, household members, emergency contacts, vehicles; effective dating, voiding, exclusion constraints, RLS | ✅ Done |
| 2 | Derived owner/tenant/household access (unit scope, today in the property's time zone); resident invitations linking a profile to a login; my units, unit detail, current residents | ✅ Done |
| 3 | Staff API: people (property-scoped visibility, organisation directory), set owners from a date (first owner and transfer), void, tenancies (move-in/out, void), household, vehicles, emergency contacts; archiving refused while occupied; per-unit locking | ✅ Done |
| 4 | Console: unit page with owners, tenancies, household and vehicles; property resident list; resident page with profile, records, emergency contacts and app invitation; browser journeys per role | ✅ Done |

## Phase 5 plan (Visitor and access management)

Decisions (owner, 2026-11-11):

- **Who registers visitors:** owners, tenants and household members of the unit, and staff from
  the console.
- **Visitor personal data:** name, optional phone and optional vehicle plate, with a category
  (guest, delivery, contractor, service provider). No ID numbers or photos without a separate
  legal and privacy assessment.
- **Walk-ins:** the resident approves in the app (in-app approval with expiry).
- **Gate offline:** both a documented paper procedure and an offline mode in the gate app.

Fixed by the PRD and threat model: a pass is random, time-limited, revocable and reveals no
personal data; a pass is never proof of identity; guards see the minimum necessary.

| Part | Scope | Status |
| ---- | ----- | ------ |
| 1 | Data foundation: visitor invitations, passes (hashes only), visits, append-only access events; online admission backstop (window, revocation, entries, row lock against two gates); immutable visits; RLS | ✅ Done |
| 2 | Security guard and supervisor roles; API: residents and staff create and revoke invitations, pass issue (QR token and reference code), guard validation with minimal data, check-in, check-out, denied entry, walk-in record; rate limits on pass lookups | Next |
| 3 | In-app walk-in approval: request to the unit's residents, approve or deny, expiry; polling first, then WebSockets | |
| 4 | Console: residents' visitor pages, the guard's gate screen (installable PWA), the supervisor's log; browser journeys per role | |
| 5 | Offline: written paper procedure and late entry; offline gate mode with a cached day list, sync, conflict handling, and late records flagged when the invitation would not have allowed them | |

## Release gates

No stage is complete on a feature demo alone. Each release requires: acceptance criteria met,
tests passing, security and permission review, migration and rollback plan, monitoring and
alerting, backup and restore validation appropriate to risk, documentation and support
readiness, user training and release communication, and known limitations documented.

## Technical debt

- Resident console: the people picker (`GET …/properties/:id/persons`) returns at most 200
  people and the console does not use its `query` filter yet; add type-ahead search when a
  property has more.
- Resident console: no UI for vehicles linked to a person (not a unit), archived vehicles,
  archiving a resident profile, or the full ownership/tenancy history of archived units' numbers
  (shown as "Archived unit"). The resident list has no paging or search (the API returns all
  current residents).
- Void reasons use the browser's native prompt (accessible, but plain); replace with the design
  system's dialog when one exists.
- Mobile app not yet launched on a device or emulator.
- `bunfig.toml` uses the hoisted linker for React Native; revisit if Bun's isolated linker gains Metro support.
- Structured logging (pino + OpenTelemetry) not yet added; Nest's default logger is in use.
- General per-user API rate limiting not yet enabled (authentication limits are).
- Built-in auth lacks MFA, email verification, password reset and breached-password checks
  (ADR 0005); required before privileged customer users go live.
- CI still starts a PostgreSQL service container that no test uses (integration tests use
  embedded-postgres). The Redis service container is now used by the rate-limiter tests.
- Authentication gaps listed in [AUTHENTICATION section 8](../security/AUTHENTICATION.md):
  sign-up email enumeration, no sign-out-everywhere, rate-limited attempts not audited.
- Console: no editing forms yet for property settings or individual buildings, floors, units
  and common areas (create and archive only); unit lists load up to 200 rows without paging.
- Units cannot move between buildings yet; optional address fields cannot be cleared once set.
- Restoring an archived property or structure is not supported (archive is final for now).
- No expired-session cleanup job yet (rows stay until a worker job prunes them).
- Production database role provisioning (veyra_owner / veyra_app from a secrets manager) not yet
  scripted.
- `dev` scripts for api/worker build once and run; no watch mode yet.
- Module-boundary lint check to be added when the second business module exists.
- Worker `main.ts` (Redis wiring, health server) has no automated test; covered by the Phase 2 integration harness.
- Invitation emails are not sent yet: the API returns the one-time token to the inviter, who
  shares the link. Sending moves to the notifications module (`@veyra/emails` has the template).
- Invitations are bound to an email address, but sign-up does not verify email ownership yet
  (ADR 0005 gap), so a token leaked to someone who registers that address could be accepted.
- Membership and invitation lists use keyset pagination; no filters or search yet.
- Effective permissions are read from the database on every request (no cache). Add the
  Redis cache with invalidation events only when measurements require it.
- No module-boundary lint rule yet: modules import each other only through their `index.ts`
  by convention.
- No Content-Security-Policy yet on the web apps (added per app once script/style sources are known).
  The console now knows its sources (self + the API origin); add its CSP next.
- Console: no membership actions (suspend/revoke) or organisation settings form in the UI yet
  (the API supports both); no localisation framework yet (error texts are centralised in
  `src/lib/messages.ts`); browser tests use a fake API, so an automated full-stack smoke test
  (console + API + database + Redis) is still missing. The Phase 4 console's requests were
  checked once by hand against the real API (2026-11-11).
- One intermittent failure of an `organisations.int.test.ts` case was seen once on a heavily
  loaded machine (2026-11-11) and not reproduced in three reruns; watch CI for repeats.
- Dependency and secret scanning not yet in CI.

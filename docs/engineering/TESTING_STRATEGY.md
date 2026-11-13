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

### Part 2: roles and visitor API

- `apps/api` integration (14, `visitors.int.test.ts`): owners, household members and staff
  register visitors and get the pass once (never listed again); residents of another unit (404),
  guards and finance officers (403) and another property's guard (404) cannot; window too long
  (400), already over or more than 90 days ahead (422). A guard sees name, category, plate and
  unit number only (no phone, no resident names), by QR token or by typed code in any case and
  spacing; a pass does not work at another property's gate. A single-entry pass admits once;
  two gates racing for the last entry: one 201, one 409. Revoked, not-yet-valid and
  host-moved-out passes are refused (voiding the host's tenancy stops the pass at once).
  Denials, for a pass or a named person, do not use up entries. Walk-ins to a unit are refused
  until in-app approval exists; walk-ins to the property are admitted, listed as inside and
  depart once. Only supervisors read the log and revoke any invitation. The 61st pass check in a
  minute is rate limited.
- `apps/api` unit (+11): pass rejection order and inclusive window ends; secrets (token length,
  code alphabet without look-alikes, per-property code hashing); input normalisation; local
  times without a zone rejected (this caught a crash in the window checks); a guard's
  permissions at a property and none at its units; only holders of gate permissions can appoint
  a guard.

### Part 3: walk-in approval

- `packages/db` integration (7, `walk-in-requests.int.test.ts`): no rows without tenant
  context; expiry within 30 minutes; a decision records who made it; decided once and never
  edited; no approval after expiry (cancel still allowed); admission to a unit refused without
  a request, with a pending one, for another unit (composite key), twice on one approval
  (unique) and after the 15-minute approval window; walk-ins to the property need no request.
- `apps/api` integration (+5): a resident approves and the guard admits once (pending and
  reused approvals refused); only residents of the unit answer, not admins, guards or residents
  of other units (household members can); denied or cancelled requests cannot be approved or
  used; at most five open requests per unit; the gate lists its requests; direct walk-ins to a
  unit stay refused.
- `apps/api` unit (+2): expiry after exactly 10 minutes; admission problems (not approved,
  lapsed after 15 minutes, already used).

### Part 4: visitor console

- `apps/console-web` unit (+6, `test/visitors.test.ts`): property-local wall-clock time to
  instant and back (Karachi, Kolkata half-hour offset, London across the daylight-saving
  change), malformed input, formatting in the property zone, countdowns. The config test checks
  that the camera is allowed on the gate route only.
- `apps/console-web` browser journeys (+7, desktop and phone, axe WCAG 2.2 AA, no horizontal
  scroll), `e2e/visitors.spec.ts`: an owner registers a visitor, sees the QR code and reference
  code once, and cancels; a guard checks a code typed in any case and spacing, sees no phone
  number, admits, is refused a used pass and records the departure; a guard refuses with a
  reason and is told a code is unknown; a walk-in waits for the resident, who lets them in from
  the unit page, and the guard admits once; staff see a unit's walk-in requests but cannot
  answer; a supervisor reads the day's visits and cancels an expected visitor; a guard has the
  gate but not the log, a finance officer neither, and the console never requests visitor data
  for them. These caught three label-in-name failures (WCAG 2.5.3) and an "Inside now" list that
  did not refresh after an admission.

### Part 5: offline gate and paper log

- `packages/db` integration (5, `offline-entries.int.test.ts`): non-ONLINE entries need the
  device reference and keep the time they happened; one row per reference (a retried sync is not
  a second visit); only paper and offline entries can be flagged; a review records who and when,
  follows a flag and happens once; the record otherwise never changes, and the departure is still
  recordable once.
- `apps/api` integration (+6): the offline list holds hashes that match the device's own hashing,
  never codes, tokens or phone numbers, trusted for exactly 4 hours; an offline admission is
  recorded at its own time, once per reference, with an idempotent departure; a pass cancelled
  before the admission is flagged and one cancelled after is not; walk-ins to a unit are flagged,
  entries from the future or older than 7 days refused; only supervisors type in the paper log;
  flagged entries are reviewed once, by supervisors only.
- `apps/api` unit (+3): admissions judged at the time they happened; time limits; what each kind
  of entry needs.
- `apps/console-web` unit (+4, `test/offline-gate.test.ts`): device hashing equals the server's;
  offline checks by token or code, refused without a list or after its 4-hour trust, outside the
  window, or when admissions already queued on the device use up the pass.
- `apps/console-web` browser journeys (+2, desktop and phone): the guard loses the connection,
  checks a code against the saved list, admits, sees the entry waiting, is refused a walk-in to a
  unit, and the entry is sent and recorded as OFFLINE_SYNC when the connection returns
  (Playwright offline emulation); a supervisor reviews a flagged entry with a note and types in a
  paper-log walk-in that goes to review.

## Phase 6 tests

### Part 1: ledger data (`packages/db` integration, 31, `ledger.int.test.ts`)

- No tenant context sees nothing in any ledger table; one tenant cannot see another's entries,
  lines or accounts; rows filed under another organisation are refused by RLS; lines pointing at
  another property's account or unit, lines in another currency than their entry, and reversals
  of another property's entry are rejected by composite keys.
- Accounts: code format; codes and system keys unique per property (the same key may exist in
  another property); an account cannot move or change its system key, and its type is fixed once
  lines use it; the application cannot delete accounts.
- Periods: no overlap within a property (allowed across properties); at most one calendar year
  long; dates never change; closing records when, reopening clears it.
- Posting: a balanced entry posts and is stamped; entry numbers are consecutive per property and
  start at 1 for each property; unbalanced, single-line and empty entries are refused; a line
  must have exactly one positive side; amounts above 2^53 stay exact; dates in a closed period or
  outside any period, archived accounts, a currency other than the property's and an archived
  property are refused; entries cannot be inserted as already posted.
- Immutability: no change to a posted entry or its lines (update, delete, adding a line, or
  turning it back into a draft) for the application, the superuser or the schema owner; TRUNCATE
  refused; drafts can be edited and discarded (lines first), but cannot move to another property
  or be numbered by hand.
- Reversals: a mirror image posts and nets every account and unit to zero; a reversal that does
  not mirror (amount or unit), is dated before the original, or reverses a draft is refused; an
  entry is reversed at most once.
- Property currency: fixed once the property has a ledger entry, still changeable without one.
- Concurrency: two concurrent postings get distinct consecutive numbers; a period cannot close
  while an entry is being posted into it; a line added while its entry is being posted is refused
  once the posting commits.
- The migration drift test confirms the migrated database matches `schema.prisma`.

### Part 2: billing

- `packages/db` integration (19, `billing.int.test.ts`): no tenant context sees nothing in any
  billing table; invoices for another tenant's unit refused; charge types book only to income
  accounts and keep their code; recurring charges cover whole months, never overlap for the same
  unit (or the whole property) and type, and change only their end month; a recurring charge is
  never billed twice for a unit and month; lines must match their invoice's unit and month and
  their charge's type; issued invoices are numbered without gaps; issuing is refused when lines do
  not add up, nobody is billed, or the ledger entry is not a posted invoice entry of the issue
  date debiting exactly the total to that unit's receivables; one entry per invoice; invoices
  cannot be inserted as issued or bill another unit's tenancy; issued invoices, lines and
  recipients never change; drafts can be edited and discarded but not moved. The Part 1 TRUNCATE
  test now includes the invoice tables that reference the ledger.
- `apps/api` unit (7, `test/finance/finance-rules.test.ts`): amounts in each currency's minor
  unit; per-sqm pricing exact and rounded half up (also above 2^53); a unit's own charge replaces
  the property-wide one; who pays (owners, tenancy, owners while vacant, nobody); months, month
  bounds (leap years), labels and invoice numbers.
- `apps/api` integration (15, `finance.int.test.ts`): finance officers set up a property
  (idempotent: 8 accounts, 2 charge types); property managers read but cannot run billing; guards
  403, residents and another property's finance officer 404; duplicate codes 409, non-income
  accounts 422; flat, per-sqm, property-wide and unit charges, overlaps 409, too many decimals
  422; ending a charge earlier but never extending it; a billing run bills owners for service
  charges and tenants (or owners while vacant) for utilities with exact totals, reports units with
  no area or nobody to bill, never bills a month twice, bills again only what was discarded; two
  concurrent runs bill each line once; runs can issue at once; issuing posts receivables and
  income and freezes the invoice; one-off invoices bill the right party and refuse mixed parties,
  past due dates and units with nobody to bill; issuing into a closed period is refused
  (`PERIOD_CLOSED`) and works once reopened; managers cannot issue. The property manager's
  permission list test now includes `property.finance.read`.

### Part 3: payments

- `packages/db` integration (14, `payments.int.test.ts`): no tenant context sees nothing in any
  payment table; consecutive receipt numbers; a payment exists only with a posted payment entry
  of its date crediting exactly its amount to the unit's credit; payments never change, not even
  for the superuser; allocations stay within the payment and the invoice, go only to issued
  invoices of the same unit and party (a tenancy's payment never pays the owners' invoice),
  are released once and can then be allocated again, and never overpay an invoice under
  concurrency; intents start pending, succeed only with their payment (of matching amount) and
  complete once; a callback can see exactly its intent and nothing else without tenant context;
  provider events are unique and append-only. The Part 1 TRUNCATE test now includes the payment
  tables that reference the ledger.
- `apps/api` unit (+6, `test/finance/payments.test.ts`): oldest-first allocation across several
  payments and invoices; which account receives each method's money; sandbox signatures accepted
  when correct and refused when missing, wrong, over a tampered body, stale (over 5 minutes) or
  not an event; unguessable references.
- `apps/api` integration (11, `payments.int.test.ts`): an Idempotency-Key and the manage
  permission are required; a payment pays the oldest invoices first and is its own receipt; the
  same key replays the same payment and refuses a different one; the same request twice at once
  records once; a tenancy's payment pays only its invoices and keeps the rest as unit credit
  (checked in the ledger); credit is applied when a new invoice is issued; future dates, a missing
  tenancy and too many decimals are refused; an allocation is released once and reallocated within
  limits and parties; managers read but cannot reallocate; the sandbox flow: wrong signature 401,
  a signed success recorded once (duplicate event and a later event ignored), a mismatched amount
  left pending, a failure recorded, unknown references answered and unknown providers 404. The
  Part 2 set-up test now expects the gateway clearing account.

### Part 4: controls and reports

- `packages/db` integration (15, `controls.int.test.ts`): no tenant context sees nothing in any
  control table; approvals and rejections by the requester, cancellations by anyone else, an
  approval not carried out, a second decision and a request naming the wrong target are refused;
  credit notes are numbered and stay within their line and what the invoice still owes (a paid or
  draft invoice refuses them), and stop allocations overpaying a credited invoice; write-offs need
  a matching approval, used once; refunds only of unused money and by the approved method, and a
  refunded amount cannot be allocated; a payment is reversed only with nothing allocated
  (released allocations do not count) and only with an approval, after which nothing is allocated
  from it; reopening a closed period needs an approval carried out after it was closed; credits
  never change, even for the superuser. The Part 1 period test now expects reopening without an
  approval to be refused, and its TRUNCATE test includes the control tables.
- `apps/api` unit (+3, `test/finance/control-rules.test.ts`): ageing buckets, statement order and
  running balance, approval request shapes.
- `apps/api` integration (8, `controls.int.test.ts`): a refund approved by a second finance
  officer (refused for the requester, 403 `SAME_PERSON`, and for a manager), decided once, reduces
  the payment's unused money and the unit credit; only the requester cancels, someone else
  rejects; a reversal releases allocations and restores the invoice and the unit credit, and
  cannot be repeated; credit notes within line and balance, numbered; a write-off only after
  approval; a closed period refuses payments until a second person approves reopening it; the
  statement's balance equals what is outstanding less unused payments; ageing totals do not change
  with `asOf`, everything is current today and overdue later. The Part 2 finance test now closes
  and reopens periods through the API and expects the bad debts account.

### Part 5: finance console for staff

- `apps/console-web` unit (`test/finance.test.ts`) and browser journeys (`e2e/finance.spec.ts`,
  backed by `e2e/fake-finance.ts`): set-up, billing, invoices, payments, approvals, reports and
  periods per role, with axe WCAG 2.2 AA checks on desktop and phone.

### Part 6: residents' finance

- `packages/db` integration (15, `bank-transfers.int.test.ts`): only a current owner submits for
  the owners and only a tenant of the current tenancy for it (not a tenant for the owners, an
  owner for the tenancy, someone with no records, or another unit's owner); future dates, other
  currencies, zero amounts and untrimmed text are refused; at most 10 wait per account; a
  submission is decided once, never by its submitter, a rejection needs a reason and a
  confirmation a BANK_TRANSFER payment of the same unit, account and amount; it starts pending,
  is invisible to other organisations and cannot be deleted. The Part 1 TRUNCATE test now
  includes the submissions table.
- `apps/api` unit (+10, `test/finance/resident-finance-rules.test.ts`): accounts from a
  resident's standing (owner, tenant, both, neither), refusing another account, matching by
  tenancy, submission input, and which roles hold the two resident finance permissions; the
  policy tests list the new owner and tenant permissions (read only on an archived property).
- `apps/api` integration (10, `resident-finance.int.test.ts`): an owner sees only the owners'
  account and a tenant only theirs (summary, invoices, invoice detail, statement, receipts);
  drafts are 404; asking for the other account is 404; a household member gets 403, another
  unit's owner 404, a manager 403 and an admin with no account 404; submissions need an
  Idempotency-Key, refuse a future date, replay with the same key and refuse it for a different
  request; a manager reads the queue but cannot decide; confirming records a receipt that pays the
  invoice and zeroes the statement, once; rejecting shows the reason to the tenant only; a finance
  officer cannot confirm or reject their own submission; the 11th waiting submission is refused.
- `apps/console-web` unit (+2) and browser journeys (3 × desktop and phone,
  `e2e/resident-finance.spec.ts`): an owner reports a transfer, finance confirms it and the owner
  sees the receipt and a settled invoice; a tenant sees only their account, gets a rejection
  reason and "not found" for the owners' invoice; an owner reads an invoice. axe WCAG 2.2 AA and
  no horizontal scroll on phones.

## Phase 7 tests

### Part 1: maintenance data (`packages/db` integration, 16, `maintenance.int.test.ts`)

- Requests are numbered per property and get response and resolution due times from the
  property's SLA target for their priority (none without a target), recomputed and logged when
  the priority changes.
- Exactly one place (unit or common area), never an archived one; trimmed text; what was
  reported never changes; accepted-by/at, reopen count and due times cannot be set by a client.
- Only the allowed request transitions, with a reason to reject, cancel or reopen; final states
  never change; acceptance records the current user; a request resolves only with completed work
  and none open, and cancels only with no open work; reopen, resolve again and close, with the
  full resident-visible history in order and the reopening resident as actor.
- Work orders are numbered per property, raised only for accepted requests and at their place;
  open work has no assignee and assigned work has one; only the allowed transitions, with a note
  to pause, complete or cancel; start and completion times set by the database; the internal
  history records each status and assignee change with its actor; work never moves to another
  request or place.
- Costs only in the property currency and never on cancelled work; never edited, voided once.
- History: the application adds notes only; a work order's note is filed under its request;
  UPDATE, DELETE and TRUNCATE are refused even for the superuser; the application cannot delete
  requests.
- Another organisation, and a connection without tenant context, see none of it.

### Part 2: roles and API

- `apps/api` unit (+9, `test/maintenance/maintenance-rules.test.ts`): transitions matching the
  database, resolving only with completed work, staff and work order inputs (exactly one place),
  exact cost amounts, numbering, and which roles hold each maintenance permission. The policy
  tests and the property manager's permission list in `properties.int.test.ts` include the new
  permissions.
- `apps/api` integration (9, `maintenance.int.test.ts`): a household member and a tenant raise
  and see the unit's requests; another unit's owner gets 404, a technician and a guard 403;
  residents see only resident-visible history (no internal notes, work orders or costs); only the
  requester cancels, and not with live work. The full journey: work can be given only to holders
  of `property.maintenance.work` at the property (not a guard or another property's technician;
  the assignee list agrees); only the assignee sees and progresses their work (another
  technician gets 404, and no technician reads the queue); hold and resume; costs exact to the
  minor unit; resolve refused while work is live; staff cannot confirm for a resident; a household
  member reopens, new work, resolve again, the tenant confirms, with the full resident history in
  order. Rejection reasons reach the resident and final requests stay final. Staff raise work for
  a common area (no resident note allowed), reassign, unassign, cancel (no costs afterwards),
  report problems, change priority, and void a cost once. A finance officer reads but cannot
  write; another property is 404.

### Part 3: file storage

- `packages/db` integration (+5 in `maintenance.int.test.ts`): only allowed types and sizes, safe
  names and a key under the tenant's prefix; checked once and removed once (READY only), nothing
  else changes; a work order's file is filed under its request, and resident files need one; none
  on finished requests or cancelled work; at most 10 (a rejected upload frees its place); another
  organisation sees none; no DELETE.
- `apps/api` contract test (3, `s3-object-storage.int.test.ts`) against a real S3-compatible
  server that checks signatures (SeaweedFS; started by CI with `infra/seaweedfs/start-ci.sh`,
  skipped without `STORAGE_TEST_ENDPOINT`): a signed upload works for exactly the signed type and
  size and is refused for any other; stat, first bytes, download with our disposition, delete;
  unsigned access refused.
- `apps/api` unit (+6, `test/maintenance/attachments.test.ts`): content sniffing (JPEG, PNG,
  WebP, HEIC, PDF; not SVG, HTML or executables), safe file names, upload limits, no storage
  configured, storage settings.
- `apps/api` integration (+5 in `maintenance.int.test.ts`, with an in-memory storage fake): a
  resident's photo appears only once checked (409 before the bytes arrive), is always
  resident-visible, and is reachable by the unit's residents and staff but not another unit; a
  file whose bytes are not what it declared, or not its size, is rejected and deleted; bad types
  and sizes are 400; internal files never reach residents; technicians add evidence to their own
  work only (resident-visible ones reach the requester); a finance officer downloads but cannot
  remove; only the uploader or a manager removes, and the object is deleted; at most 10 per
  request, none on a cancelled request.

### Part 4: SLAs and the outbox relay

- `packages/db` integration (+6 in `maintenance.int.test.ts`): due times are scheduled in the
  outbox with ids only; a missed target is recorded once, with an internal history event, never
  before it is due and not for a stale due time; a met target is not recorded; a breach that is
  not true, or recorded with other changes, is refused; a priority change that moves a target
  into the future clears it and schedules the new time; the outbox claim returns due events of a
  type oldest first, published ones never again, and a failure holds an event back.
- `apps/api` unit (+3): `overdue` (only past a target not yet met), the queue order, SLA target
  input.
- `apps/api` integration (+3 in `maintenance.int.test.ts`): managers set targets (one per
  priority), finance reads them; new requests get due times, recomputed on a priority change;
  the worker's check (run as the worker does) records a breach once, visible to staff only, and
  the overdue request leads the queue; technicians cannot read the queue.
- `apps/worker` unit (+6, `test/outbox-relay.test.ts`): due events become tenant jobs keyed by the
  outbox id and are marked published; an event without a tenant, or a queue failure, is held
  back without blocking the others; the SLA check runs in the tenant's context, refuses a
  malformed payload, and is a tenant job. The env test requires `DATABASE_URL`.

### Part 5: maintenance console

- `apps/console-web` unit (+5, `test/maintenance.test.ts`): place and history wording, file
  checks before upload, sizes and due times, upload and storage error messages.
- `packages/design-tokens` unit (+1): every text and status colour has at least 4.5:1 contrast on
  the page background and on cards, in both schemes (the warning colour was darkened).
- Browser journeys (3 × desktop and phone, `e2e/maintenance.spec.ts`, backed by
  `e2e/fake-maintenance.ts` and a fake storage host): a resident reports a problem with a photo;
  the maintenance manager accepts it with a message and gives it to a technician; the technician
  starts, records a cost, adds an after photo and finishes; the manager marks it done; the
  resident sees the updates and the photo (not the work order) and confirms. Managers set targets
  (refused when fixing is due before the response); technicians cannot open the queue and see
  only their own work. A file whose content is not what it claims is refused, and a text file is
  refused before upload. axe WCAG 2.2 AA and no horizontal scroll on phones.

## Phase 8 tests

### Part 1: facilities data (`packages/db` integration, 14, `facilities.int.test.ts`)

- Facilities only for an active common area, one each, with valid settings, starting active;
  archived only when nothing upcoming is booked, then final and closed to bookings.
- Opening hours of a day never overlap (touching ranges are fine) and are replaced by deleting.
- Bookings are numbered per property and counted in slots; the facility decides PENDING or
  CONFIRMED whatever the client sends, and the creation time is the database's; the first
  history event names the booker.
- Whole slots on a slot boundary inside opening hours, at most the facility maximum (half-hour
  slots on another facility); notice and advance windows; no booking in the past.
- No overbooking: exclusive use with back-to-back bookings allowed, shared capacity of two with
  the third refused where they overlap, pending bookings hold their place until rejected; two
  connections booking the same slot at once: the second is refused once the first commits.
- The per-unit limit of upcoming bookings, per unit; a cancelled booking frees the allowance.
- Closures block bookings until lifted, never cover a live booking (cancel it first), are never
  edited and are lifted once.
- Only the allowed status transitions, with reasons to reject and to cancel a confirmed booking;
  approval records the decider and needs a person; used or no-show only once started; place and
  time never change; final states never change; the history lists each change with its actor.
- History is written only by the database and is append-only even for the superuser; the
  application cannot delete bookings. Another organisation, and a connection without tenant
  context, see none of it.

### Part 2: facilities API

- `apps/api` unit (7, `test/facilities/facility-rules.test.ts`): transitions and reasons
  matching the database, the residents' cancellation window, slot states (open with places
  left, full, closed, too soon, too far), opening-hours parsing and overlap, input schemas.
- `apps/api` integration (9, `test/integration/facilities.int.test.ts`): managers set up
  facilities (one per common area; overlapping hours refused); a security supervisor reads but
  changes nothing; finance has no access; another property's manager gets 404. Residents see a
  property-local day of slots, book two slots and the times turn FULL; taken, off-grid, outside
  hours, too many slots and too far ahead come back with their codes; household members cannot
  book (403); another unit's bookings are 404; staff book on a resident's behalf. Residents
  cancel before the window (default reason once confirmed), not inside it (409
  `TOO_LATE_TO_CANCEL`); staff cancel later with a reason. A pending hall booking holds its
  place; the manager approves (history names them) or rejects with a reason the resident sees.
  Closures refuse to cover bookings unless told to cancel them, mark the day CLOSED and block
  booking until lifted (once). Archiving needs nothing upcoming and hides the facility.
- `apps/api` unit (access control): owners now hold `unit.facility.book`.

### Part 3: fees and deposits

- `packages/db` integration (+2 in `facilities.int.test.ts`): a fee only through an active
  income charge type and a deposit only through a liability one, each with a positive amount; a
  booking keeps the fee (slots x fee) and deposit it was made with whatever the client sends,
  and they never change; only an issued invoice links to a booking; the deposit is not released
  without an invoice; a finished booking still refuses status changes.
- `apps/api` integration (+3 in `facilities.int.test.ts`): finance set-up provides FACILITY and
  DEPOSIT charge types; wrong or half-given charges are 422; a confirmed booking is invoiced to
  the tenants at once (two lines, total, outstanding) and cancelling credits all of it; with
  approval nothing is charged until approved, then the owners of a unit without tenancy are
  billed; the deposit is released only once the booking is used, once, by a credit note; a
  rejected booking is never charged.

### Part 4: facilities console

- `apps/console-web` unit (3, `test/facilities.test.ts`): today's date in the property's time
  zone, durations, weekly hours merged by day, booking rules in plain words.
- Browser journeys (2, `e2e/facilities.spec.ts`, desktop and phone, with an in-memory
  `e2e/fake-facilities.ts`): a tenant opens Facilities from their home, picks a day and a free
  slot, books it with a purpose, sees the slot turn unavailable and the booking confirmed, then
  cancels it with a reason; the slot grid fits a 375px screen. A property manager makes a party
  room bookable with approval; the tenant's booking waits; the manager approves it from the
  queue and finds it under confirmed. axe WCAG 2.2 AA on each screen.

## Phase 9 tests

### Part 1: vendors

- `packages/db` integration (6, `vendors.int.test.ts`): vendors start active with trimmed,
  lower-case details and a name unique (ignoring case) among live ones; archived frees the name
  and is final; suspending needs a reason that clears on reactivation; documents are never edited,
  voided once, not added to archived vendors, never expire before they start; work orders go to an
  active vendor without a technician, logged as `VENDOR_CHANGED` with the actor; open work cannot
  have a vendor; a vendor with open work is not archived; suspended vendors get no work; another
  organisation sees nothing and the application cannot delete.
- `apps/api` integration (3, `vendors.int.test.ts`): admins register vendors (duplicate names
  409, bad email 400), finance reads but cannot change, a property's maintenance manager cannot
  open the register; compliance moves from expired to no documents (voided) to expiring soon;
  managers see only active vendors, give work to one (assigned, logged), are refused a suspended
  one, cannot archive a vendor with open work until the vendor is taken off it (back to open).
- `apps/api` unit (access control): finance officers now read vendors.

### Part 2: assets and preventive maintenance

- `packages/db` integration (4, `assets.int.test.ts`): unique upper-case tags and exactly one
  place; assets start in use; out of service needs a note; retiring waits for paused schedules and
  finished work and is final, and a retired asset's schedule cannot be resumed; work on an asset
  is at its place; scheduled work needs its date, is raised once per schedule and date, keeps its
  links and stays on the schedule's asset; isolation and no deletes.
- `apps/api` unit (4, `test/maintenance/asset-rules.test.ts`): interval arithmetic (month ends,
  leap years, weeks across years), lead time, skipping missed periods, tag and place input.
- `apps/api` integration (3, `assets.int.test.ts`): managers register assets (duplicate tag 409)
  and technicians cannot; raising due work creates one work order for the due schedule only, at
  the asset's place and to its vendor, a second run raises nothing and the next date moves on;
  out-of-service assets are skipped; retiring waits for the schedule to be paused, then is final.

### Part 3: departments, shifts and handovers

- `packages/db` integration (6, `staff.int.test.ts`): department names unique among active
  ones; members once at a time and removed once; archiving waits for live shifts and frees the
  name; shifts only for current members, 15 minutes to 24 hours, never overlapping for a person
  (back to back and other people are fine; two connections at once: the second is refused);
  start then end with a handover note, times set by the database, moved only before starting,
  cancelled only with a reason, final states never change; isolation and no deletes.
- `apps/api` integration (4, `staff.int.test.ts`): supervisors create departments (duplicates
  409) and add only people who work at the property, guards cannot manage; overlapping shifts
  409, non-members 422, over 24 hours 400; staff see only their own shifts; a guard starts and
  ends with a handover note the next guard sees; starting too early is 409; moving, cancelling
  with a reason, and archiving or removing blocked by live shifts.
- `apps/api` unit (access control): guards and technicians now work shifts.

### Part 4: checklists

- `packages/db` integration (4, `checklists.int.test.ts`): templates of 1-50 trimmed checks,
  archived for good and then unusable; checks answered only while open, a failed check needs a
  note, answer person and time from the database; submitting needs every answer; the assignee
  cannot verify; returning needs a note and reopens; verified is final; a shift must belong to
  the same person; wording never changes; cancelling needs a reason; isolation and no deletes.
- `apps/api` integration (2, `checklists.int.test.ts`): a supervisor writes a template (guards
  cannot) and gives it to a guard; a later template change leaves it as given; another guard gets
  404; a failed check without a note is 400, submitting early 422, answering after submitting
  409; returned with a note, fixed, resubmitted and verified; a supervisor's own checklist is 403
  for them to verify; an archived template is 409.

### Part 5: operations console

- Browser journeys (2, `e2e/operations.spec.ts`, desktop and phone, with an in-memory
  `e2e/fake-ops.ts`): an admin opens Vendors from the organisation, adds a vendor and its
  insurance, and sees its papers go from none on file to in order. A security supervisor adds a
  department and a guard, plans a shift and gives a checklist; the guard starts the shift, answers
  the checks (a problem without a note is stopped on the page), hands the checklist in and ends the
  shift with a handover; the supervisor sees the answers and the handover and verifies it. axe
  WCAG 2.2 AA on each screen. Asset screens are covered by the API tests (no journey yet).

## Phase 10 tests

### Part 1: announcements

- `packages/db` integration (4, `announcements.int.test.ts`): the resident audience lists
  current residents with a login (not former tenants, not people without a login), and one
  building's; drafts are edited, a building only for building audiences, copies only of published
  announcements, publishing records the publisher and fixes the content, withdrawing needs a
  reason and is final; only the recipient reads or acknowledges, acknowledging only where asked,
  once, and also reads; one copy per person; isolation and no deletes.
- `apps/api` integration (3, `announcements.int.test.ts`): an urgent announcement to residents
  reaches the owner and the tenant only, who read and acknowledge it, and the manager sees the
  figures; building, staff and everyone audiences; a building audience without a building is 400;
  guards cannot publish, residents get 404 on manager routes; withdrawn announcements leave
  inboxes; strangers see an empty inbox.

### Part 2: notifications

- `packages/db` integration (3, `notifications.int.test.ts`): only the recipient marks a
  notification read and nothing else changes; kinds are checked; each delivery writes its outbox
  event with only its id; the application role cannot update deliveries; outcomes count attempts,
  fail after the last one, leave finished deliveries alone and stay within the caller's tenant.
- `apps/worker` unit (3, `notification-jobs.test.ts`): a pending email is sent and recorded and
  the log holds neither the address nor the content; a failure is recorded and retried until the
  last attempt fails it; deliveries gone or finished are skipped; bad payloads refused. The relay
  test now claims both event types.
- `apps/api` integration (2, `notifications.int.test.ts`): approving a booking and accepting a
  maintenance request notify the tenant with a link and a pending email; an urgent announcement
  notifies residents by email too; a stranger's feed is empty and cannot mark others' items read;
  read and read-all; managers see the deliveries, residents get 404.

### Part 3: documents

- `packages/db` integration (3, `documents.int.test.ts`): versions numbered per document, keys
  under the tenant prefix, only allowed types and sizes; a version is checked once; archived
  documents are final and take no versions; isolation and no deletes.
- `apps/api` integration (2, `documents.int.test.ts`, with the in-memory storage fake): nothing
  is shown before its file is checked; owners see documents for owners, tenants only those for
  residents and everyone, guards those for staff and everyone, managers all; another unit's
  documents are 404, as is a download of an owners' document by a tenant; managers see every
  version and readers the newest; a file that is not a PDF is rejected and deleted; guards cannot
  archive; archived documents disappear and take no new versions.

### Part 4: communications console

- `apps/console-web` unit (2, `test/communications.test.ts`): document file checks (type, empty,
  20 MB) and expiry wording.
- Browser journeys (2, `e2e/communications.spec.ts`, desktop and phone, with an in-memory
  `e2e/fake-comms.ts`): a property manager publishes an urgent announcement asking for
  acknowledgement; the tenant opens the inbox from the organisation page, reads it and confirms;
  the manager sees it reached, read and acknowledged by one person. The tenant opens Documents from
  their home and sees the document for everyone but not the owners' one. axe WCAG 2.2 AA.

## Phase 11 tests

### Part 1: incidents

- `packages/db` integration (5, `incidents.int.test.ts`): numbering per property, open at start,
  never in the future, the report never changes; the status machine, outcome to resolve, reopen,
  every action done to close, closed is final, the timeline written by the database in order; no
  notes on closed incidents, status rows only from the trigger, no edits; isolation and no
  deletes; escalation contact checks.
- `apps/api` unit (5, `test/incidents/incident-rules.test.ts`): moves, visibility of sensitive
  incidents, alerting severities, contacts per kind, input checks.
- `apps/api` integration (4, `incidents.int.test.ts`): a guard's critical report alerts the
  manager and not the reporter, future times refused; sensitive incidents hidden (404) from other
  staff and outsiders; only managers change status, resolve with an outcome, close only when the
  technician given the follow-up has done it (others cannot mark it), notes refused once closed,
  open vs all lists; escalation contacts managed by managers, filtered by kind and retired.

### Part 2: committees and meetings

- `packages/db` integration (4, `governance.int.test.ts`): one seat per person and one chair at a
  time, a term ended once, terms that make sense; dissolved committees take no seats or meetings,
  active names unique; meetings not held early, cancelled only with a reason, agenda fixed once
  held, minutes approved once and then final, resolutions numbered and only at a held meeting
  before approval; resolutions never change; isolation and no deletes.
- `apps/api` unit (3, `test/governance/governance-rules.test.ts`): current seats, what each
  meeting state allows, term and vote count checks.
- `apps/api` integration (3, `governance.int.test.ts`): seats only for Committee members, one
  chair, terms ended once; a meeting with an agenda is held, resolutions recorded (unknown
  documents refused), minutes approved once and then final; committee members read but cannot
  change, guards see nothing; cancelling, no early holding, dissolving only without scheduled
  meetings.

### Part 3: approval policies

- `packages/db` integration (5, `approvals.int.test.ts`): requests numbered per property, in its
  currency, never changed, settled only by decisions; approved at the required number, never
  decided by the requester or for someone else, once per person; rejected at the first rejection
  with a reason; withdrawn only by the requester; one active policy per threshold, committees only
  for committee approval and not dissolved; decisions never change; isolation and no deletes.
- `apps/api` unit (3, `test/governance/approval-rules.test.ts`): choosing the policy by type and
  threshold, committee shape, rejection reasons and amounts.
- `apps/api` integration (3, `approvals.int.test.ts`): one manager approves without a policy and
  both sides are notified; a policy sends large expenses to the committee needing two
  approvals (managers refused, one decision per person, amounts in the property's decimals);
  rejection with a reason, withdrawal only by the requester, pending vs all lists.

### Part 4: governance console

- `apps/console-web` unit (2, `test/governance.test.ts`): the incident moves offered (closing
  only with every follow-up done) and approval progress wording.
- Browser journeys (3, `e2e/governance.spec.ts`, desktop and phone, with an in-memory
  `e2e/fake-governance.ts`): a guard reports a critical incident (managers alerted, whom to call
  shown); the manager responds, is told an outcome is needed, resolves and closes it. The manager
  schedules a committee meeting with an agenda, holds it, records a resolution, writes and
  approves the minutes (then final); a committee member reads them without the controls. A
  maintenance manager asks for approval of an amount; the manager approves it and it leaves the
  waiting list. axe WCAG 2.2 AA.

## Phase 12 tests

### Part 1: dashboards

- `apps/api` integration (3, `reporting.int.test.ts`): a manager sees every area with correct
  occupancy, incident, finance and zero figures; a guard and a technician see only their areas
  and no sensitive incidents; people outside the property get 404.

### Part 2: exports

- `apps/api` unit (3, `test/reporting/export-rules.test.ts`): CSV escaping and formula
  defusing, small-group suppression, default and maximum date ranges.
- `apps/api` integration (1 more in `reporting.int.test.ts`): the exports a manager may download
  and none for a guard; a formula-like building name defused, a two-unit group suppressed;
  incidents without free text, ranges too long or reversed refused; an empty arrears file;
  unknown export names refused.

### Part 3: webhooks

- `packages/db` integration (4, `webhooks.int.test.ts`): endpoint URL rules, secrets rotating
  forward only; deliveries only to active subscribed endpoints with an outbox event each (the
  test event to any); outcomes only through the function, counting attempts and leaving settled
  ones alone; isolation and no deletes.
- `apps/worker` unit (4, `webhook-jobs.test.ts`): signed sends verified with the derived secret
  (a changed body, old timestamp or old secret fails), retries and the last failure, skipped and
  refused deliveries, private addresses refused even behind a public name.
- `apps/api` unit (3, `test/integrations/webhook-rules.test.ts`) and integration (3,
  `webhooks.int.test.ts`): HTTPS public hosts only, known events; the secret shown once and
  matching the worker's derivation, rotation; incident reports queue deliveries (never sensitive
  ones); test events; disabled endpoints get nothing; only admins manage endpoints.

### Part 4: reporting console

- `apps/console-web` unit (2, `test/reporting.test.ts`): export file names and refused exports.
- Browser journeys (3, `e2e/reporting.spec.ts`, desktop and phone, with an in-memory
  `e2e/fake-reporting.ts`): a manager sees every area's figures and downloads an export (the
  download is recorded); a guard sees only their areas and no exports; an organisation admin adds
  a webhook endpoint, sees the secret once, sends a test, reads the delivery and disables it.
  axe WCAG 2.2 AA.

## Phase 13 tests

### Part 1: subscriptions

- `packages/db` integration (4, `subscriptions.int.test.ts`): new organisations get a logged
  30-day trial; subscriptions, plans and history are read-only to the application; property and
  unit limits; isolation.
- `apps/api` unit (3, `test/access-control/entitlements.test.ts`): every permission has a
  feature, plan filtering, when a subscription lapses.
- `apps/api` integration (4, `subscriptions.int.test.ts`): the plan page for admins only; a
  smaller plan turns routes off (403) and permissions away for everyone; limits answer 409
  `PLAN_LIMIT_REACHED`; an ended trial makes the organisation read-only until reactivated.

### Part 2: platform administration

- `packages/db` integration (3, `platform-admin.int.test.ts`): platform admins read
  organisations and subscriptions across tenants but no properties, and usage as counts; plan and
  status changes only through the functions, for admins only, with a reason, audited in the
  tenant; only the owner grants; revocation takes effect at once.
- `apps/api` integration (4, `platform-admin.int.test.ts`): routes hidden (404) from everyone but
  platform admins; organisation list with plan and usage, no tenant data; plan changes with a
  reason switch features at once and show in the customer's history; suspension makes the
  organisation read-only until reactivated.

### Part 3: support access

- `packages/db` integration (3, `support-access.int.test.ts`): asked only by platform admins
  through the function (reason, at most 24 hours, no direct inserts); decided by the
  organisation, never the requester; the window; revocation; audit of every step; visible to the
  organisation and the requester only.
- `apps/api` integration (3, `support-access.int.test.ts`): nothing before approval; property
  managers cannot decide; approval gives reads only (no changes, no exports, no deciding);
  revocation ends access at once and is final.

### Part 4: platform screens

- `apps/admin-web` unit (3, `test/platform.test.ts`): plan summaries, the plan change form's
  checks, refused requests turned into readable errors.
- Browser journeys (2, `e2e/plan.spec.ts`, desktop and phone, with an in-memory
  `e2e/fake-platform.ts`): an organisation admin sees the plan, its limits and features, approves
  a support request and ends it; a property manager does not see the page. axe WCAG 2.2 AA. The
  admin tool has no browser journeys yet.

## Phase 14 tests

### Part 1: email verification and password reset

- `packages/emails` unit (2, `test/account.test.ts`): links, expiry and escaping; HTTPS links
  only (localhost in development).
- `apps/api` integration (4, `account-recovery.int.test.ts`): the confirmation link works once,
  only the newest link works, resending when confirmed sends nothing; reset requests answer the
  same for unknown addresses and send nothing; a reset replaces the password, ends every
  session, confirms the address and works once.
- `apps/console-web` unit (1, `test/account.test.ts`) and browser journeys (2,
  `e2e/account.spec.ts`): forgot password from sign-in, choosing a new password from the link
  (mismatch refused, incomplete links explained); the reminder banner, sending the link again,
  confirming from the link. axe WCAG 2.2 AA.

### Part 2: two-step sign-in

- `apps/api` unit (5, `test/identity/totp.test.ts`): the RFC 6238 test vectors, base32, one step
  of drift and no reuse of a step, sealed secrets only the key opens, recovery codes and the
  authenticator link.
- `apps/api` integration (4, `mfa.int.test.ts`, enforcement on, controllable clock): privileged
  changes refused until set up, reads always allowed; turning it on with a code gives ten
  recovery codes and verifies the session; a new session must verify, the same code never works
  twice, the next one does; recovery codes work once; other roles unaffected; platform
  administrators bound too; turning it off needs a verified session and a current code.
- Browser journey (1, `e2e/mfa.spec.ts`, desktop and phone): set up with the QR code and key,
  wrong code refused, recovery codes shown once, a later session prompted and verified with a
  recovery code. axe WCAG 2.2 AA.

### Part 3: operational hardening

- `apps/api` unit (5, `test/platform/json-logger.test.ts`, `test/platform/file-scanner.test.ts`):
  redaction of bearer tokens, cookies, named secrets, query strings, emails and long opaque
  strings while ids stay; JSON lines by level; clamd answers, chunked INSTREAM against a fake
  clamd (with a harmless marker, not real test malware), failing closed when unreachable.
- `apps/api` integration (2, `upload-scanning.int.test.ts`): infected uploads rejected and
  deleted; uploads stay pending (503) while the scanner is down and complete afterwards.
- `packages/web-config` (2, `test/csp.test.ts`) and `apps/console-web` (`test/next-config.test.ts`):
  the policy names only the API and storage origins, forbids framing, plugins and foreign forms,
  and allows eval only in development. The full browser suite runs with the policy on.
- CI: gitleaks scans the checkout before dependencies are installed; `bun audit` fails on high
  and critical advisories.

### Part 4: launch readiness

- CI `smoke` job: builds the image, starts PostgreSQL, Redis, migrations, API, worker and console
  in production mode (`infra/compose/full-stack.yml`), then `infra/smoke/smoke.ts` walks sign-up,
  the two-step sign-in requirement and set-up, an organisation, property and unit, the dashboard
  and the trial subscription, and checks the console's security headers.
- `infra/scripts/restore-drill.sh` in the same job: a logical backup restored into a fresh
  database with identical row counts in every table.

### Phase 15: mobile apps

- `@veyra/client` unit tests: bearer and cookie sessions, the 401 hook, network errors versus
  aborts, path safety, upload failures, gate hashing, and the moved console helpers.
- Each app's `src/lib` has Vitest unit tests (resident: property-time-zone days and times, QR
  matrix). Screens are typechecked, and `expo export --platform android` bundles them as a
  check that every import resolves. Device journeys (Maestro) come with the first store release.

## Critical scenarios to add as features land

Cross-tenant access, unauthorised financial access, expired memberships, duplicate payment
callbacks, invalid visitor passes, concurrent facility bookings, failed notifications,
transaction failures, permission changes during sessions, tenant export and deletion.

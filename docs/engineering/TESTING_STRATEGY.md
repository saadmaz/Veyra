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

## Critical scenarios to add as features land

Cross-tenant access, unauthorised financial access, expired memberships, duplicate payment
callbacks, invalid visitor passes, concurrent facility bookings, failed notifications,
transaction failures, permission changes during sessions, tenant export and deletion.

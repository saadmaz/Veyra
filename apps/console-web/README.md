# VEYRA Console (`@veyra/console-web`)

The main management web app at `app.veyra.com`, for organisation admins, property managers,
finance officers and committee members. The **Operations** experience for security and
maintenance staff (visitor check-in, incidents, work orders) is built here too, as a responsive,
installable PWA. It moves to its own app only if it outgrows this one.

```powershell
bun run --cwd apps/console-web dev   # http://localhost:3000 (needs the API on :4000)
```

## Screens

| Route | Purpose |
| ----- | ------- |
| `/sign-in`, `/sign-up` | Sign in or create an account; `?next=` returns to the requested page (same-site paths only) |
| `/organisations` | The user's organisations, empty state with "create" |
| `/organisations/new` | Create an organisation (the creator becomes its admin) |
| `/organisations/[id]` | Overview; "Your homes" for residents; members and invitations when the user may see them |
| `/invitations/accept#token=…` | Accept an invitation; the token is in the URL fragment, never sent to a server |
| `/organisations/[id]/properties/new` | Add a property (organisation admins) |
| `/organisations/[id]/properties/[pid]` | Property overview, activate/archive (admins), buildings, units, common areas, invite a property manager |
| `/organisations/[id]/properties/[pid]/buildings/[bid]` | A building's floors and units |
| `/organisations/[id]/properties/[pid]/units/[uid]` | A unit: details for every staff role and its residents; owners and tenants see who lives there; for admins and property managers its owners (exact shares, transfers), tenancies (move-in, move-out), household, vehicles; voiding mistakes with a reason |
| `/organisations/[id]/properties/[pid]/gate` | Gate screen for security staff (phone-first): check a pass by reference code or by scanning its QR code, admit or refuse with a reason; send walk-in requests to a unit's residents and admit on their approval; record departures of visitors inside |
| `/organisations/[id]/properties/[pid]/visitors` | Visit log by day (property time) and expected visitors with cancel, for supervisors and managers |
| `/organisations/[id]/properties/[pid]/residents` | Current residents of the property with their units and roles; add a person |
| `/organisations/[id]/properties/[pid]/residents/[personId]` | A resident's profile (edit), records at this property, emergency contacts, app invitation link |
| `/organisations/[id]/properties/[pid]/finance` | Finance overview: set up finance, what is owed now by age, requests waiting for approval, chart of accounts |
| `…/finance/billing` | Charge types (add, archive), recurring charges (flat or per m², end), the monthly billing run (drafts or issued at once) |
| `…/finance/invoices`, `…/finance/invoices/[invoiceId]` | Invoices by status, unit and month; a one-line one-off draft; an invoice's lines and credits; issue or discard a draft, credit note, write-off request |
| `…/finance/payments`, `…/finance/payments/[paymentId]` | Record a bank transfer, cash or cheque (with an `Idempotency-Key`); receipts; apply unused money to an invoice, take an allocation back, refund or reversal request |
| `…/finance/approvals` | Maker-checker requests by status; the requester can cancel; someone else approves or rejects with a note |
| `…/finance/reports` | Ageing by unit and party, a unit's statement with running balance, accounting periods (close; reopen by request) |

On the unit page, residents of the unit and staff also register visitors: the pass (QR code and
`XXXX-XXXX` reference code) is shown once and only its hashes are stored by the API. The unit's
residents answer walk-in requests from the gate there ("Visitors at the gate"); staff see them
but cannot answer. Requests are checked for every 5 seconds while the page is open (instant
delivery comes later). Visit times are entered and shown in the property's time zone.

Resident records are never edited in place: periods are ended, and mistakes are voided (kept
and shown as voided). Dates are calendar dates in the property's time zone. Ownership shares are
typed as fractions ("1/2") and checked exactly, never as floating point. Roles without resident
permissions (finance officers) see unit details only; the console does not request resident
data for them.

The organisation page lists the properties the user may see (the API filters them). Controls
appear only when the API reports the matching permission (`permissions` on organisation and
property responses); the API enforces every action regardless. Archiving asks for confirmation.

Finance pages need `property.finance.read`; set-up, billing, invoices, payments and requests need
`property.finance.manage`, and decisions `property.finance.approve` (finance officers and
organisation admins; property managers read only). The console hides approve and reject on the
caller's own requests; the API refuses them anyway (`SAME_PERSON`). Amounts are minor units held
as `bigint` through `Money` from `@veyra/domain` and formatted with the currency's ISO 4217
decimals; amounts typed in are checked the same way before they are sent, and the API checks
them again. A payment keeps its `Idempotency-Key` across retries unless the API answered 400 or
422, so a retry after a dropped connection never records the money twice. Residents do not see
finance yet (Phase 6 Part 6).

The header has a skip link, an organisation switcher (native `<select>`) and sign-out.

## Installable app and camera

The console has a web app manifest (`src/app/manifest.ts`) so the gate phone can add it to its
home screen. If the connection drops while the gate screen is open, it keeps working offline
(`src/lib/offline-gate.ts`, `src/lib/use-offline-gate.ts`): passes are checked against a saved
4-hour list of hashes and entries queue on the device until the connection returns. Opening the
screen without a connection is not supported yet (no service worker); see
[GATE_OFFLINE](../../docs/operations/GATE_OFFLINE.md). The camera is allowed
on the gate page only (`next.config.ts` overrides the shared `Permissions-Policy` for that
route); every other page keeps it off. Scanning uses the browser's own `BarcodeDetector`
(Chromium, e.g. Chrome on Android); elsewhere guards type the reference code.

**Dependency:** `qrcode-generator` (MIT, no dependencies of its own) draws pass QR codes; the
console renders its module grid as SVG elements (no HTML injection). There is no scanning
library.

## How it talks to the API

Pages are client components that call the API directly with `credentials: 'include'`, using
the API's httpOnly session cookie ([ADR 0006](../../docs/adr/0006-console-calls-api-from-browser.md)).
`NEXT_PUBLIC_API_BASE_URL` sets the API address (default `http://localhost:4000/api/v1`) and is
read at build time. The API's `API_CORS_ORIGINS` must include the console's origin.

## Structure

- `src/app/` routes: `(auth)` sign-in/up layout, `(console)` signed-in layout, invitation page.
- `src/components/` shared UI (`ui.tsx`: buttons, fields, alerts, loading/empty/error states;
  `app-shell.tsx`; `residents.tsx`: person picker, new-person form, period badges;
  `unit-records.tsx`: the unit page's owner, tenancy, household and vehicle cards).
- `src/lib/` API client, session context, data hook, error messages, safe redirects,
  `residents.ts` (exact shares, property-local dates, period status), `finance.ts` (money
  display and input, labels, the idempotency-key rule).
- `src/components/finance-frame.tsx`: the frame of every finance page (property, permission
  states, breadcrumb, section navigation).
- `e2e/fake-api.ts` and `e2e/fake-finance.ts`: the in-memory API the browser journeys run against.
- Styling: `src/app/globals.css`, values from `@veyra/design-tokens` only.

## Tests

- `bun run test`: unit tests for the client library (`test/`).
- `bun run test:e2e`: Playwright journeys in Chromium at desktop and phone sizes, with axe
  WCAG 2.2 AA checks (`e2e/`). Needs a production build (`bun run build`) and, once,
  `bunx playwright install chromium`. API calls are answered by `e2e/fake-api.ts`.
  The suite starts `next start` on port 3000, or reuses a server already there; a `next dev`
  server on 3000 makes journeys time out, so stop it first. On a busy machine use
  `--workers=1`.

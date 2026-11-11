# Phase 6 exit review: Finance and billing

- **Date:** 2026-11-11
- **Scope:** PRs #27 (ledger foundation), #28 (billing), #29 (payments), #30 (controls and
  reports), #31 (finance console for staff), and Part 6 (residents' finance and bank-transfer
  submissions, this change)
- **Decision:** Phase 6 is complete for a pilot without a real payment provider. Proceed to
  Phase 7 (maintenance and work orders) once the owner has reviewed this document. Bank
  statement import, late fees, tax lines, expenses and budgets are out of scope by owner
  decision or later phases (section 5). The pilot-readiness items from the Phase 2 review are
  still open; for finance, MFA for finance staff matters most.

Owner decisions (2026-11-11 and 2026-11-12): service charges billed to owners, usage charges to
the current tenant (owners while vacant); flat or per-square-metre recurring charges; manual
payments plus a gateway port with a sandbox adapter, no real provider yet; no late fees; no tax
lines yet; oldest-first allocation with unit credit; maker-checker for reversals, write-offs,
refunds and reopening a closed period, decided by any finance officer or organisation admin
other than the requester; residents see their own invoices, receipts and statement and submit
bank-transfer references for finance to confirm.

## 1. Exit criteria

| Criterion | Status | Evidence |
| --------- | ------ | -------- |
| Double-entry: every posted entry balances | ✅ | Posting trigger refuses unbalanced, mixed-currency, inactive-account and closed-period postings; gap-free numbering per property (db tests) |
| Posted entries are immutable for every role | ✅ | Triggers refuse UPDATE, DELETE and TRUNCATE on posted entries and lines, even for the superuser and the schema owner; corrections are mirrored reversals, at most once (db tests) |
| Money is never a floating-point number | ✅ | `bigint` minor units with the currency everywhere (database, API, console); ISO 4217 exponents (JPY 0, KWD 3) tested in `@veyra/domain` and the console |
| Balances are derived, not stored | ✅ | Invoice paid/credited/outstanding, payment unused, statements and ageing are computed from allocations, credits, refunds and reversals; the database recomputes them in every allocation and credit check |
| Every payment and transfer is recorded once | ✅ | Idempotency keys on payments and bank-transfer submissions (unique per organisation; replay returns the original, a different request 409); provider callbacks unique per `(provider, event id)` (db and API tests) |
| Risky actions need a second person | ✅ | Maker-checker in the API (403 `SAME_PERSON`) and in database CHECKs for approvals and for confirming a resident's own transfer (db and API tests) |
| Each party sees only its own account | ✅ | Staff by property permission; residents by their own records on every request: an owner never sees a tenancy's invoices or the reverse, household members and neighbours see nothing, drafts never appear (API tests, browser journeys) |
| Tenant and property isolation | ✅ | RLS and composite foreign keys on every finance table; other properties' staff get 404 (db and API tests) |

## 2. Product requirements (PRD 3.4)

| Requirement | Status |
| ----------- | ------ |
| Recurring, one-off and utility charges | ✅ Flat or per sqm; liable party per charge type |
| Deposits, penalties | ⏳ No late fees in Phase 6 (owner decision); deposits with facilities (Phase 8) |
| Credits and waivers | ✅ Credit notes (no approval) and write-offs (maker-checker) |
| Invoices and statements for the correct liable party | ✅ Party fixed on the billing date; recipients captured on the invoice |
| Due dates, allocations, adjustments | ✅ Overdue status, oldest-first allocation, reallocation |
| Disputes | ⏳ Not built: a resident can report a transfer but not dispute a charge (communications, Phase 10) |
| Online gateway payments | ⚠️ Port, signed idempotent callbacks and a sandbox adapter; no real provider (owner decision) |
| Manual bank-transfer recording | ✅ Recorded by finance, or reported by a resident and confirmed by finance |
| Reconcile provider callbacks | ✅ Amount and currency checked; mismatches kept pending (no screen to resolve them yet) |
| Bank statement imports | ⏳ Not built (later phase) |
| Receipts and account statements | ✅ For staff and for residents |
| Refunds and reversals through controlled workflows | ✅ Maker-checker |
| Immutable posted ledger | ✅ |
| Property currency and accounting periods | ✅ Currency fixed once entries exist; monthly periods; close and approved reopen |
| Ageing report | ✅ Collection, income, expense and budget reports later (Phase 12) |
| No card data stored | ✅ Only provider references |

## 3. Verification at the time of review

Run locally on 2026-11-11 (Windows 11, Node 24, Bun 1.4.4).

| Suite | Result |
| ----- | ------ |
| Lint, typecheck (18 workspaces), build (12) | ✅ |
| Unit tests | ✅ API 184, console 50, domain 20, db 9, worker 6, other packages 16 |
| Integration, real PostgreSQL 17 | ✅ db 208, API 169. The 5 Redis tests did not run locally (Docker Desktop not running); they run in CI |
| Browser journeys (desktop and phone, axe WCAG 2.2 AA) | ✅ 84 of 84 with two workers (the CI setting). With four local workers some journeys timed out under load and pass when rerun |
| CI `verify` | ✅ #27-#31 green before merge; Part 6 to be confirmed on its PR |

The console build needs `NODE_ENV=production` (or unset); a shell with `NODE_ENV=development`
fails while prerendering `/_global-error`. CI does not set it.

## 4. Design review

| Area | Assessment |
| ---- | ---------- |
| Authorisation | Three property permissions for staff (read, manage, approve) and two unit permissions for residents (read, pay), the latter always narrowed to the caller's own account resolved from their records on each request |
| Integrity | Every money rule is in the API and repeated in the database: balanced postings, immutability, allocation and credit limits under advisory locks, maker-checker CHECKs, matching payment for a confirmed transfer |
| Privacy | Finance officers see invoice recipients' names only; residents see co-owners' names on their own invoices, never contact details; a write-off's internal reason is hidden from residents; audit entries hold ids and amounts, no bank references or names |
| Concurrency | Row locks on decisions, advisory locks per payment, invoice and unit; idempotent creates |
| Dependencies | None added in Phase 6 |
| Architecture | One `finance` module owning its tables; the statement is built by one function shared by staff and residents, so both always agree |

## 5. Open items

### Still required before a pilot stores real data (unchanged from Phase 2)

MFA (required for finance actions, ACCESS_CONTROL rule 7), email verification and password
reset; structured JSON logging with redaction; secret scanning in CI; console
Content-Security-Policy; production database roles and tested backups; an automated full-stack
smoke test. Accounting policy reviewed by a qualified accountant before claiming statutory
accounting support.

### New in Phase 6, can wait

- A real payment provider adapter, and residents paying online from the console.
- Bank statement import and matching (would let finance confirm transfers in bulk).
- Expiring payment intents and a screen to resolve `AMOUNT_MISMATCH` callbacks (worker job).
- Paging for invoice, payment, approval and transfer lists (200 most recent today).
- Statements with a date range and opening balance; ageing as of a past date.
- Notifications: an approver or finance learning that something waits, a resident learning that
  a transfer was confirmed or rejected (communications, Phase 10).
- Residents: attaching a bank slip to a transfer (file storage); withdrawing a submission;
  former tenants and owners keeping read access to their past account (today access ends with
  the record).
- Chart of accounts editing; billing runs as worker jobs for very large properties; tax adapters.

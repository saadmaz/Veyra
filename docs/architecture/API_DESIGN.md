# API Design

> Status: Phase 2 (authentication endpoints implemented).

## Conventions

- Base path: `/api/v1`. Breaking changes require a new version; additive changes do not.
- Tenant-scoped resources are nested: `/api/v1/organisations/{organisationId}/properties/{propertyId}/units`.
- JSON, `camelCase` fields, ISO-8601 UTC timestamps, money as `{ "amountMinor": "125000", "currency": "PKR" }`
  (amount as a string to avoid JS number precision loss).
- OpenAPI document generated from code, served at `/api/docs` (non-production) and
  exported as a CI artifact.

## Errors

Every error uses one envelope:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request validation failed",
    "details": [{ "path": "email", "message": "Invalid email" }],
    "requestId": "0b9f..."
  }
}
```

| HTTP | code examples |
| ---- | ------------- |
| 400  | `VALIDATION_FAILED`, `BAD_REQUEST` |
| 401  | `UNAUTHENTICATED`, `INVALID_CREDENTIALS` |
| 403  | `FORBIDDEN`, `ORIGIN_NOT_ALLOWED`, `ROLE_NOT_ASSIGNABLE`, `INVITATION_EMAIL_MISMATCH` |
| 404  | `NOT_FOUND` (also returned for resources in another tenant, to avoid leaking existence), `INVITATION_NOT_FOUND` |
| 409  | `CONFLICT`, `INVALID_STATE_TRANSITION`, `EMAIL_ALREADY_REGISTERED`, `SLUG_TAKEN`, `PROPERTY_CODE_TAKEN`, `BUILDING_CODE_TAKEN`, `FLOOR_LEVEL_TAKEN`, `UNIT_NUMBER_TAKEN`, `COMMON_AREA_NAME_TAKEN`, `STRUCTURE_IN_USE`, `ARCHIVED`, `PROPERTY_FINANCIALS_LOCKED`, `LAST_ADMIN`, `ALREADY_MEMBER`, `INVITATION_PENDING`, `INVITATION_ALREADY_USED`, `INVITATION_REVOKED`, `INVITATION_EXPIRED`, `PERSON_ALREADY_LINKED`, `USER_ALREADY_LINKED`, `PERSON_EMAIL_TAKEN`, `PLATE_TAKEN`, `OWNERSHIP_CONFLICT`, `TENANCY_OVERLAP`, `HOUSEHOLD_OVERLAP`, `RESIDENCY_RULE_VIOLATED`, `UNIT_OCCUPIED`, `PROPERTY_OCCUPIED`, `VOIDED` |
| 422  | domain rule violations, e.g. `BOOKING_SLOT_TAKEN`, `ROLE_SCOPE_MISMATCH`, `PERSON_HAS_NO_EMAIL`, `INVALID_PERIOD` |
| 429  | `RATE_LIMITED` (with `Retry-After`) |
| 500  | `INTERNAL_ERROR` (no internals in the message) |
| 503  | `SERVICE_UNAVAILABLE` |

## Authentication

Every route requires a session unless marked `@Public()`. Web clients use an httpOnly cookie,
mobile clients `Authorization: Bearer`. Details: [AUTHENTICATION](../security/AUTHENTICATION.md).

## Organisations (Phase 2)

| Method | Path | Access |
| ------ | ---- | ------ |
| POST | `/organisations` | Authenticated (caller becomes organisation admin; 5 per user per day) |
| GET | `/organisations` | Authenticated (caller's organisations and roles) |
| GET | `/organisations/{organisationId}` | `organisation.profile.read` (includes the caller's `permissions`, for UI only) |
| PATCH | `/organisations/{organisationId}` | `organisation.settings.manage` (name, default time zone; country and currency are fixed) |
| GET | `/organisations/{organisationId}/memberships` | `organisation.member.read` |
| PATCH | `/organisations/{organisationId}/memberships/{membershipId}` | `organisation.member.manage` (`status`: ACTIVE, SUSPENDED, REVOKED) |
| POST | `/organisations/{organisationId}/invitations` | `organisation.member.invite` (returns the one-time `token`) |
| GET | `/organisations/{organisationId}/invitations` | `organisation.member.invite` |
| POST | `/organisations/{organisationId}/invitations/{invitationId}/revoke` | `organisation.member.invite` |
| POST | `/invitations/accept` | Authenticated (`{ token }`; the account email must match; 10 attempts per 15 min) |

Invitations take an optional `propertyId` to grant a role for one property (e.g.
`PROPERTY_MANAGER`); responses include `scopeType` and `scopeId`.

## Properties (Phase 3)

| Method | Path | Access |
| ------ | ---- | ------ |
| POST | `/organisations/{organisationId}/properties` | `organisation.property.create` (country, time zone and currency default to the organisation's) |
| GET | `/organisations/{organisationId}/properties` | Any member; filtered to the properties the caller's grants reach |
| GET | `/organisations/{organisationId}/properties/{propertyId}` | `property.profile.read` at that property (includes the caller's `permissions`) |
| PATCH | `…/properties/{propertyId}` | `property.settings.manage` (country and currency only while `ONBOARDING`) |
| POST | `…/properties/{propertyId}/activate`, `…/archive` | `property.lifecycle.manage` (archive cascades to the whole structure) |

Structure, all under `…/properties/{propertyId}`; reading needs `property.structure.read`, every
change `property.structure.manage`. Lists show active rows; `?status=ARCHIVED` shows the archive.

| Resource | Endpoints |
| -------- | --------- |
| Buildings | `GET/POST buildings`, `GET/PATCH buildings/{id}`, `POST buildings/{id}/archive` (no active units; archives its floors and common areas) |
| Floors | `GET/POST buildings/{buildingId}/floors`, `PATCH …/floors/{id}`, `POST …/floors/{id}/archive` (no active units) |
| Units | `GET units?buildingId=&floorId=`, `POST units`, `PATCH units/{id}`, `POST units/{id}/archive` |
| Common areas | `GET/POST common-areas`, `PATCH common-areas/{id}`, `POST common-areas/{id}/archive` |

Unit `areaSqm` and `shareRatio` are decimal strings (`"85.50"`), never JSON numbers.

## Residents (Phase 4)

| Method | Path | Access |
| ------ | ---- | ------ |
| POST | `/organisations/{organisationId}/persons/{personId}/invitations` | `organisation.member.invite`; links the profile to a login on acceptance |
| GET | `/organisations/{organisationId}/my-units` | Any member; the caller's units today with their derived roles |
| GET | `/organisations/{organisationId}/properties/{propertyId}/units/{unitId}` | `unit.profile.read` (includes `myRoles`, `permissions` and `propertyTimeZone`) |
| GET | `…/units/{unitId}/residents` | `unit.residents.read`; current owners, tenants and household, names only |

Staff side (all under `/organisations/{organisationId}`):

| Method | Path | Access |
| ------ | ---- | ------ |
| GET | `persons?query=`, `persons/{personId}` | `organisation.resident.read` (directory) |
| POST | `properties/{propertyId}/persons` | `property.resident.manage` |
| GET | `properties/{propertyId}/persons?query=` | `property.resident.read`; people staff may pick for this property: its residents and profiles not attached anywhere yet (max 200) |
| GET | `properties/{propertyId}/residents` | `property.resident.read`; current residents with units and roles |
| GET / PATCH | `properties/{propertyId}/persons/{personId}` | read / manage; person, records in this property, emergency contacts |
| POST / DELETE | `…/persons/{personId}/emergency-contacts[/{contactId}]` | manage |
| GET | `…/units/{unitId}/ownerships` | read; full history incl. ended and voided |
| POST | `…/units/{unitId}/owners` | manage; set owners from a date (first owner or transfer), exact shares summing to one |
| POST | `…/units/{unitId}/ownerships/void` | manage; `{ ownershipIds, reason }` |
| GET / POST | `…/units/{unitId}/tenancies` | read / manage (move-in, exactly one primary tenant) |
| POST | `…/tenancies/{tenancyId}/end`, `…/void` | manage (move-out sets the last day) |
| GET / POST | `…/units/{unitId}/household`; POST `…/household/{memberId}/end`, `…/void` | read / manage |
| GET / POST | `properties/{propertyId}/vehicles`; POST `…/vehicles/{vehicleId}/archive` | read / manage |

Dates are `YYYY-MM-DD` in the property's calendar with inclusive end dates. Archiving a unit,
or a property, is refused with `UNIT_OCCUPIED` / `PROPERTY_OCCUPIED` while current or future
ownership, tenancy or household records exist.

## Visitors and the gate (Phase 5)

All under `/organisations/{organisationId}/properties/{propertyId}`. Times are ISO 8601 instants
with an offset; the console shows them in the property's time zone.

| Method | Path | Access |
| ------ | ---- | ------ |
| POST | `units/{unitId}/visitor-invitations` | `unit.visitor.invite`; returns the pass (QR `token`, reference `code`) **once**; only hashes are stored |
| GET | `units/{unitId}/visitor-invitations` | `unit.visitor.invite`; current, upcoming and recently ended |
| POST | `units/{unitId}/visitor-invitations/{invitationId}/revoke` | `unit.visitor.invite` (anyone who may register visitors for the unit) |
| GET | `visitor-invitations` | `property.visitor.read` |
| POST | `visitor-invitations/{invitationId}/revoke` | `property.visitor.manage` |
| POST | `gate/validate` | `property.visitor.check_in`; `{ token }` or `{ code }`; answers `{ valid, pass }` or `{ valid: false, reason }`; 60 checks per guard per minute |
| POST | `gate/admit` | `property.visitor.check_in`; `{ passId }`; re-checked under a row lock (409 `PASS_NOT_VALID`) |
| POST | `gate/deny` | `property.visitor.check_in`; for a pass or a named person; needs a reason |
| POST | `gate/walk-in` | `property.visitor.check_in`; to the property: admitted; to a unit: 409 `WALK_IN_NEEDS_APPROVAL` (send a walk-in request) |
| POST | `gate/walk-in-requests` | `property.visitor.check_in`; `{ unitId, category, visitorName, visitorPhone?, vehiclePlate?, gate? }`; residents have 10 minutes; at most 5 open per unit (409 `TOO_MANY_WALK_IN_REQUESTS`) |
| GET | `gate/walk-in-requests`, `gate/walk-in-requests/{requestId}` | `property.visitor.check_in`; last 24 hours / one request (poll for the answer) |
| POST | `gate/walk-in-requests/{requestId}/admit`, `…/cancel` | `property.visitor.check_in`; admit once within 15 minutes of an approval (409 `WALK_IN_NOT_APPROVED`) |
| GET | `units/{unitId}/walk-in-requests` | `unit.visitor.invite`; waiting and recent requests for the unit |
| POST | `units/{unitId}/walk-in-requests/{requestId}/approve`, `…/deny` | `unit.visitor.invite` **and** a current owner, tenant or household role on the unit (staff get 403); before expiry (409 `WALK_IN_EXPIRED`, `WALK_IN_NOT_PENDING`) |
| POST | `visits/{visitId}/depart` | `property.visitor.check_in`; once (409 `VISIT_ALREADY_DEPARTED`) |
| GET | `visits/inside` | `property.visitor.check_in`; admitted and not departed |
| GET | `visits?from=&to=` | `property.visitor.read`; up to 31 days |
| GET | `gate/offline-list` | `property.visitor.check_in`; passes usable in the next 4 hours as hashes (`tokenHash`, `codeHash`), never codes; refused by the device after `trustUntil` |
| POST | `gate/late-entries` | `property.visitor.check_in`; `{ source: OFFLINE_SYNC \| PAPER, entries }` (PAPER also needs `property.visitor.manage`); up to 200 entries; per entry `RECORDED`, `ALREADY_RECORDED` (same `clientRef`) or `REJECTED` (`TOO_OLD` over 7 days, `IN_THE_FUTURE`, `NOT_FOUND`, `BEFORE_ARRIVAL`); recorded entries carry `reviewReason` when flagged |
| GET | `visits/needs-review` | `property.visitor.read`; flagged entries not yet reviewed |
| POST | `visits/{visitId}/review` | `property.visitor.manage`; `{ note? }`; once (409 `ALREADY_REVIEWED`, `NOT_FLAGGED`) |

What a guard sees of a pass is limited to visitor name, category, plate, unit number, end of the
window and entries left: no phone, no resident names. Rejection reasons: `NOT_FOUND`, `REVOKED`,
`NOT_YET_VALID`, `EXPIRED`, `NO_ENTRIES_LEFT`, `HOST_NO_LONGER_RESIDENT` (the resident who
registered the visitor no longer lives there). Every check, admission, denial and departure is
written to the append-only access log.

## Finance and billing (Phase 6)

All under `/organisations/{organisationId}/properties/{propertyId}/finance`. Amounts in
responses are `{ amountMinor, currency }` (minor units as a string, the property's currency);
amounts in requests are decimal strings such as `"1500.50"`, refused if they have more decimals
than the currency. Months are `YYYY-MM`; dates are property-local `YYYY-MM-DD`.

| Method | Path | Access |
| ------ | ---- | ------ |
| POST | `setup` | `property.finance.manage`; creates the default chart of accounts and the `SERVICE` (owners) and `UTILITIES` (occupant) charge types that are missing; safe to repeat |
| GET | `accounts` | `property.finance.read` |
| GET / POST | `charge-types`; POST `charge-types/{id}/archive` | read / manage; a charge type books to an active income account; codes unique (409 `CODE_TAKEN`) |
| GET / POST | `recurring-charges` | read / manage; `{ unitId?, chargeTypeId, basis: FLAT \| PER_SQM, amount, startMonth, endMonth? }`; no unitId = every active unit; overlapping months for the same unit (or the whole property) and type: 409 `OVERLAPPING_CHARGE` |
| POST | `recurring-charges/{id}/end` | manage; `{ endMonth }`; only earlier, never extended |
| POST | `billing-runs` | manage; `{ month, dueDate, issue? }`; bills each active unit once per recurring charge and month: one invoice per unit and party; reports units it cannot bill (`NO_AREA`, `NO_OWNER`); a concurrent run billing the same lines gets 409 `ALREADY_BILLED` |
| GET | `invoices?status=&unitId=&billingMonth=` | read; the 200 most recent |
| POST | `invoices` | manage; a one-off draft `{ unitId, dueDate, lines: [{ chargeTypeId, description?, amount }] }`; all lines must bill the same party (422) |
| GET | `invoices/{id}` | read; with lines and the ledger entry id once issued |
| POST | `invoices/{id}/issue` | manage; `{ dueDate? }`; numbers the invoice (`INV-000042`) and posts it to the ledger today (property-local); 409 `ALREADY_ISSUED`, `PERIOD_CLOSED`, `FINANCE_NOT_SET_UP` |
| POST | `invoices/{id}/discard` | manage; drafts only (409 `ALREADY_ISSUED`); a discarded run line can be billed again |

Who pays (owner decision): `OWNERS` charge types bill the unit's owners on the billing date (the
first day of the month for runs, today for one-off invoices); `OCCUPANT` types bill the current
tenancy, or the owners while the unit has none. Issuing opens the month's accounting period if
no period covers today. Invoices show `paid` and `outstanding`.

### Payments (Phase 6 Part 3)

| Method | Path | Access |
| ------ | ---- | ------ |
| POST | `payments` | manage; header `Idempotency-Key` (a UUID, 400 without it); `{ unitId, paidBy: OWNERS \| TENANTS, method: BANK_TRANSFER \| CASH \| CHEQUE, amount, receivedOn, reference? }`; 201 with the payment (its receipt, `RCT-000042`); the same key and request again: 200 with the same payment; the same key with a different request: 409 `IDEMPOTENCY_KEY_REUSED`; applied to the paying party's unpaid invoices oldest first, the rest kept as credit |
| GET | `payments?unitId=`, `payments/{id}` | read; the 200 most recent / one payment with its allocations |
| POST | `payments/{id}/allocations` | manage; `{ invoiceId, amount }`; an issued invoice of the same unit and party, within what is left of both (422) |
| POST | `allocations/{id}/release` | manage; once (409 `ALREADY_RELEASED`); the money returns to the payment's unused part and is not re-applied automatically |
| POST | `payment-intents` | manage; `{ unitId, paidBy, amount }`; returns the intent and the provider's `checkoutUrl`; 409 `GATEWAY_NOT_CONFIGURED` |
| GET | `payment-intents/{id}` | read |

Provider callbacks: `POST /api/v1/payment-callbacks/{provider}` is public but must carry the
provider's signature over the raw body (sandbox: header `veyra-sandbox-signature:
t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`, 5-minute window): 401 `INVALID_SIGNATURE` otherwise,
404 for an unknown provider. A verified callback always gets 200 with an `outcome`: `RECORDED`,
`FAILED`, `DUPLICATE` (event already processed), `IGNORED_NOT_PENDING`, `AMOUNT_MISMATCH` (left
pending for finance) or `UNKNOWN_REFERENCE`. Only the signed callback records an online payment,
never a browser redirect. The sandbox gateway (no money moves) is enabled by
`PAYMENT_SANDBOX_SECRET` and refused in production.

### Controls and reports (Phase 6 Part 4)

| Method | Path | Access |
| ------ | ---- | ------ |
| GET | `periods` | read |
| POST | `periods/{id}/close` | manage; nothing posts into a closed period (409 `PERIOD_CLOSED`); 409 `ALREADY_CLOSED` |
| POST | `approvals` | manage; one of `{ action: REVERSE_PAYMENT, paymentId }`, `{ action: REFUND, paymentId, amount, method }`, `{ action: WRITE_OFF, invoiceId, amount }`, `{ action: REOPEN_PERIOD, periodId }`, each with a `reason`; checked now (422/409) and again when approved |
| GET | `approvals?status=`, `approvals/{id}` | read |
| POST | `approvals/{id}/approve` | `property.finance.approve`, never the requester (403 `SAME_PERSON`); `{ note? }`; carries the action out in the same transaction; 409 `ALREADY_DECIDED`, or a 409 when the action is no longer possible (e.g. the payment was meanwhile allocated) |
| POST | `approvals/{id}/reject` | `property.finance.approve`, never the requester |
| POST | `approvals/{id}/cancel` | manage; the requester only (403 `NOT_REQUESTER`) |
| POST | `invoices/{id}/credit-notes` | manage; `{ lineNumber, amount, reason }`; within the line and what the invoice still owes (release payments first); numbered `CRN-000042`; no approval needed |
| GET | `units/{unitId}/statement?paidBy=OWNERS\|TENANTS&tenancyId=` | read; invoices, credit notes, write-offs, payments, refunds and reversals with a running balance (positive: owed) |
| GET | `ageing?asOf=` | read; what each unit and party owes now, bucketed by days past due on `asOf` (default today): `current`, `days1to30`, `days31to60`, `days61to90`, `over90` |

What each approved action does: a **refund** pays back unused payment money (debit unit credit,
credit bank or cash); a **write-off** gives up on what an invoice owes (debit bad debts, credit
receivables); a **payment reversal** releases the payment's allocations and reverses its ledger
entry (a bounced cheque), after which the payment is ignored; **reopening** a period lets
postings into it again. Invoices show `credited` and `overdue`; payments show `refunded` and
`reversedOn`.

### Residents' finance (Phase 6 Part 6)

Under `/organisations/{orgId}/properties/{propertyId}/units/{unitId}/my-finance`. Unit-scoped:
`unit.finance.read` (owners and current tenants; household members 403). Every answer is
narrowed to **the caller's own account**: an owner sees the owners' account, a tenant the account
of the tenancy they are on today. Asking for an account that is not yours, an invoice or receipt
of another account, or a draft invoice is 404; so is a caller with the permission but no
account on the unit (e.g. an organisation admin who does not live there).

| Method | Path | Access |
| ------ | ---- | ------ |
| GET | (the base path) | read; `{ unitId, unitNumber, asOf, currency, accounts: [{ paidBy, tenancyId, balance, overdue, pendingTransfers }] }` |
| GET | `invoices?paidBy=` | read; issued invoices of your account(s), newest first, at most 200 |
| GET | `invoices/{id}` | read; lines and credits (a write-off's reason reads "Written off"); no `journalEntryId` |
| GET | `payments?paidBy=`, `payments/{id}` | read; your receipts and what they paid |
| GET | `statement?paidBy=OWNERS\|TENANTS` | read; the same statement finance sees for that account |
| GET | `bank-transfers` | read; transfers reported for your accounts, newest first |
| POST | `bank-transfers` | `unit.finance.pay`; header `Idempotency-Key` (400 without it); `{ paidBy, amount, transferredOn, reference, note? }`; 201 PENDING; a replay 200; the key with another request 409 `IDEMPOTENCY_KEY_REUSED`; future date 422; 10 already waiting 409 `TOO_MANY_PENDING` |

Finance checks them under the property's `finance/`:

| Method | Path | Access |
| ------ | ---- | ------ |
| GET | `bank-transfers?status=PENDING\|CONFIRMED\|REJECTED` | read |
| POST | `bank-transfers/{id}/confirm` | manage, never the submitter (403 `SAME_PERSON`); `{ receivedOn? }` (default: the date the resident gave); records a `BANK_TRANSFER` payment for that account with the resident's reference, applied oldest first like any payment; 409 `ALREADY_DECIDED` |
| POST | `bank-transfers/{id}/reject` | manage, never the submitter; `{ reason }` (shown to the resident) |

## Maintenance (Phase 7)

Residents, under `/organisations/{orgId}/properties/{propertyId}/units/{unitId}/maintenance-requests`
(`unit.maintenance.request`; other units' requests are 404). Responses carry the request and its
**resident-visible** events only: never work orders, internal notes, assignees or costs.

| Method | Path | Access |
| ------ | ---- | ------ |
| GET | (the base path) | the unit's requests, newest first, at most 200 |
| POST | (the base path) | `{ category, priority? (MEDIUM), title, description, locationDetail? }`; 201 `SUBMITTED`, numbered `MR-000042`; 409 `ARCHIVED` for an archived unit |
| GET | `{id}` | `{ request, events }` |
| POST | `{id}/cancel` | the requester only (403 `NOT_REQUESTER`); `{ reason }`; not once work is live (409) |
| POST | `{id}/confirm` | a current resident only (403 for staff); `RESOLVED → CLOSED` |
| POST | `{id}/reopen` | a current resident only; `{ reason }`; `RESOLVED → ACCEPTED` |
| POST | `{id}/notes` | `{ body }`, shown to staff and the unit's residents; 409 once the request is final |

Staff, under the property's `maintenance/` (`property.maintenance.read` to read, `.manage` for the rest):

| Method | Path | Access |
| ------ | ---- | ------ |
| GET | `requests?status=&unitId=` | read |
| POST | `requests` | manage; as above plus exactly one of `unitId`, `commonAreaId` |
| GET | `requests/{id}` | read; `{ request, workOrders, events }` (every event) |
| PATCH | `requests/{id}` | manage; `{ priority?, category? }` while new or accepted; the priority recomputes the SLA due times |
| POST | `requests/{id}/accept` | manage; `{ priority?, category?, note? }` (the note is shown to the requester) |
| POST | `requests/{id}/reject`, `…/cancel` | manage; `{ reason }` shown to the requester; cancel only with no live work |
| POST | `requests/{id}/resolve` | manage; `{ note? }`; only with completed work and none live (409) |
| POST | `requests/{id}/close` | manage; a resolved request, without waiting for the requester |
| POST | `requests/{id}/notes` | manage; `{ body, visibility: RESIDENT \| INTERNAL }` |
| GET | `assignees` | manage; people holding `property.maintenance.work` here |
| GET | `work-orders?status=&assignedToUserId=&requestId=` | read |
| POST | `work-orders` | manage; `{ requestId }` (an accepted request: its place, title, category, priority and description by default) or exactly one of `unitId`, `commonAreaId` with `title` and `category`; `assignedToUserId?`, `dueAt?`; numbered `WO-000042`; 422 `ASSIGNEE_NOT_ALLOWED` |
| GET | `work-orders/{id}` | read; `{ workOrder, costs, totalCost, events }` |
| PATCH | `work-orders/{id}` | manage; `{ priority?, dueAt? }` while live |
| POST | `work-orders/{id}/assign` | manage; `{ userId }`: open work becomes assigned; live work is reassigned |
| POST | `work-orders/{id}/unassign` | manage; assigned work that has not started |
| POST | `work-orders/{id}/cancel` | manage; `{ reason }` |
| POST | `work-orders/{id}/notes` | manage; `{ body, visibility }` (RESIDENT only for work with a request, else 422) |
| POST | `work-orders/{id}/costs` | manage; `{ kind: LABOUR \| MATERIAL \| OTHER, description, amount }` in the property's currency (422 `INVALID_MONEY` for too many decimals); not on cancelled work |
| POST | `costs/{id}/void` | manage; `{ reason }`; once |

Technicians, under the property's `my-work-orders` (`property.maintenance.work`): `GET ?status=`,
`GET {id}`, `POST {id}/start` (assigned or on hold), `POST {id}/hold { reason }`,
`POST {id}/complete { note }` (what was done), `POST {id}/notes`, `POST {id}/costs`. Work assigned
to someone else is 404. A transition that is not allowed is 409 `INVALID_STATE_TRANSITION`.

**Attachments** (Phase 7 Part 3, ADR 0007). Three steps: ask (`POST …/attachments` with
`{ fileName, contentType: image/jpeg | image/png | image/webp | image/heic | application/pdf,
sizeBytes ≤ 10 MB, kind?, visibility? }`, 201 `{ attachmentId, upload: { url, method: PUT,
headers, expiresAt } }`), PUT the bytes to `url` with exactly those headers within 10 minutes,
then `POST …/attachments/{id}/complete` (200 with the attachment; 409 `UPLOAD_MISSING` before the
bytes arrive, retryable; 422 `FILE_REJECTED` when the size or the real type differs, and the file
is deleted). `GET …/attachments/{id}/download` returns `{ url, expiresAt }` valid for 5 minutes;
`POST …/attachments/{id}/remove` (204) removes it. Detail responses list checked attachments.
More than 10 files, or a finished request or cancelled work, is 409 `ATTACHMENT_NOT_ALLOWED`;
without storage configured every file route is 409 `STORAGE_NOT_CONFIGURED`.

| Who | Ask | Complete, download, remove |
| --- | --- | -------------------------- |
| Residents | `units/{unitId}/maintenance-requests/{id}/attachments` (always RESIDENT, kind OTHER) | `…/{id}/attachments/{attachmentId}/…`; they see RESIDENT files of their unit's request only; complete and remove their own uploads (403 `NOT_UPLOADER`) |
| Staff | `maintenance/requests/{id}/attachments`, `maintenance/work-orders/{id}/attachments` (manage) | `maintenance/attachments/{attachmentId}/…`: download with read, complete and remove with manage (any file) |
| Technicians | `my-work-orders/{id}/attachments` (their own work; RESIDENT only for work with a request) | `my-work-orders/{id}/attachments/{attachmentId}/…`; their own uploads |

## Pagination

Cursor-based: `?limit=50&cursor=<opaque>`; response `{ "data": [...], "nextCursor": "..." | null }`.
Maximum `limit` 200.

## Idempotency

Mutating endpoints that create money movements or external side effects accept an
`Idempotency-Key` header. The key + route + actor is stored with the response for 24h;
a replay returns the stored response.

## Rate limiting

Per user and per IP, Redis-backed. Stricter limits on authentication, invitation and
visitor-pass endpoints. Authentication limits are implemented (see AUTHENTICATION section 5);
general per-user limits are not yet.

## Webhooks (outbound)

Signed with HMAC-SHA256 over `timestamp.body`, header `Veyra-Signature: t=...,v1=...`.
Receivers must reject timestamps older than 5 minutes.

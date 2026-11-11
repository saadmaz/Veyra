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
| GET | `/organisations/{organisationId}/properties/{propertyId}/units/{unitId}` | `unit.profile.read` (includes `myRoles` and `permissions`) |
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

What a guard sees of a pass is limited to visitor name, category, plate, unit number, end of the
window and entries left: no phone, no resident names. Rejection reasons: `NOT_FOUND`, `REVOKED`,
`NOT_YET_VALID`, `EXPIRED`, `NO_ENTRIES_LEFT`, `HOST_NO_LONGER_RESIDENT` (the resident who
registered the visitor no longer lives there). Every check, admission, denial and departure is
written to the append-only access log.

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

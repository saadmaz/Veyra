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
| 409  | `CONFLICT`, `INVALID_STATE_TRANSITION`, `EMAIL_ALREADY_REGISTERED`, `SLUG_TAKEN`, `PROPERTY_CODE_TAKEN`, `BUILDING_CODE_TAKEN`, `FLOOR_LEVEL_TAKEN`, `UNIT_NUMBER_TAKEN`, `COMMON_AREA_NAME_TAKEN`, `STRUCTURE_IN_USE`, `ARCHIVED`, `PROPERTY_FINANCIALS_LOCKED`, `LAST_ADMIN`, `ALREADY_MEMBER`, `INVITATION_PENDING`, `INVITATION_ALREADY_USED`, `INVITATION_REVOKED`, `INVITATION_EXPIRED` |
| 422  | domain rule violations, e.g. `BOOKING_SLOT_TAKEN`, `ROLE_SCOPE_MISMATCH` |
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

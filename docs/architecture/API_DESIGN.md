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
| 403  | `FORBIDDEN`, `ORIGIN_NOT_ALLOWED` |
| 404  | `NOT_FOUND` (also returned for resources in another tenant, to avoid leaking existence) |
| 409  | `CONFLICT`, `INVALID_STATE_TRANSITION`, `EMAIL_ALREADY_REGISTERED` |
| 422  | domain rule violations, e.g. `BOOKING_SLOT_TAKEN` |
| 429  | `RATE_LIMITED` (with `Retry-After`) |
| 500  | `INTERNAL_ERROR` (no internals in the message) |
| 503  | `SERVICE_UNAVAILABLE` |

## Authentication

Every route requires a session unless marked `@Public()`. Web clients use an httpOnly cookie,
mobile clients `Authorization: Bearer`. Details: [AUTHENTICATION](../security/AUTHENTICATION.md).

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

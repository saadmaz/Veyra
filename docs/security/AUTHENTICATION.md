# Authentication

> Status: Phase 2, Part 4. Built-in authentication as decided in
> [ADR 0005](../adr/0005-built-in-authentication.md). Code: `apps/api/src/modules/identity`.

## 1. Endpoints

All under `/api/v1/auth`. Request and response types: `@veyra/api-contracts`.

| Method | Path | Auth | Result |
| ------ | ---- | ---- | ------ |
| POST | `/sign-up` | Public | `201` user + session. Web: cookie. Mobile: `token` in body. |
| POST | `/sign-in` | Public | `200` user + session (same delivery as sign-up). |
| POST | `/sign-out` | Session | `204`. Revokes the session server-side; web cookie cleared. |
| GET | `/session` | Session | `200` current user and client type. |

`client` in the sign-up / sign-in body is `web` (default) or `mobile`. Responses that carry a
session send `Cache-Control: no-store`.

| Error | When |
| ----- | ---- |
| `400 VALIDATION_FAILED` | Malformed input (field details; passwords are never echoed). |
| `401 INVALID_CREDENTIALS` | Wrong password, unknown email or disabled account: one message for all three. |
| `401 UNAUTHENTICATED` | Missing, unknown, expired, revoked or wrong-transport session. |
| `403 ORIGIN_NOT_ALLOWED` | State-changing request from an origin outside `API_CORS_ORIGINS`. |
| `409 EMAIL_ALREADY_REGISTERED` | Sign-up with an existing email (see known gaps). |
| `429 RATE_LIMITED` | Limit reached; `Retry-After` header in seconds. |
| `503 SERVICE_UNAVAILABLE` | Rate limiter (Redis) unreachable: authentication fails closed. |

## 2. Deny by default

`AuthGuard` is registered globally. Every route requires a valid session unless it is marked
`@Public()` (from `src/platform/auth/public.decorator.ts`). Today only health checks, sign-up and
sign-in are public. Handlers read the caller with `@CurrentPrincipal()`, which carries identity
only; authorisation (memberships, roles, scopes) arrives in Part 5.

## 3. Passwords

- argon2id via `@node-rs/argon2`: 19 MiB memory, 2 iterations, 1 lane (OWASP baseline), random
  16-byte salt, PHC string in `password_credentials.password_hash`.
- Hashes made with weaker parameters are re-hashed at the next successful sign-in.
- Policy (NIST SP 800-63B): 12 to 128 characters, counted as Unicode characters after NFKC
  normalisation; no composition rules. Sign-in does not apply the length rule, so it cannot
  reveal anything about stored passwords.
- Sign-in for an unknown email still verifies against a real hash, so timing does not reveal
  whether the account exists.

## 4. Sessions

| | Web | Mobile |
| - | --- | ------ |
| Transport | `httpOnly`, `SameSite=Lax`, `Path=/` cookie. Production: `__Host-veyra_session`, `Secure`. Development: `veyra_session`. | `Authorization: Bearer <token>`, stored in the platform secure store |
| Idle expiry | 30 minutes | 30 days |
| Absolute expiry | 7 days | 90 days |

- Token: 32 random bytes, base64url. Only its SHA-256 hash is stored (`sessions.token_hash`).
- `sessions.client` records the transport; a token is rejected on the other one, so a mobile
  token cannot be replayed as a cookie and vice versa.
- Activity extends the idle expiry at most once a minute, never past the absolute expiry.
- A session stops working immediately when it is revoked (sign-out), when either expiry passes,
  or when the user is disabled.

## 5. Abuse protection

| Limit | Value | Key |
| ----- | ----- | --- |
| Sign-in attempts per IP | 20 / 15 min | client IP |
| Failed sign-ins per email | 5 / 15 min, from any IP; cleared by a successful sign-in | SHA-256 of the email (no addresses in Redis) |
| Sign-ups per IP | 10 / hour | client IP |

Counters are fixed windows in Redis (`INCR` + `PEXPIRE NX` in one transaction), shared by all API
instances. If Redis is unavailable, sign-up and sign-in return `503` rather than run unlimited.

Behind a proxy or CDN, set `API_TRUST_PROXY` to the number of proxy hops so the client IP comes
from `X-Forwarded-For`. With the default `0`, the socket address is used. Never set it higher
than the real number of hops: clients could then spoof their IP.

## 6. Cross-site request forgery

- `SameSite=Lax` stops browsers from sending the session cookie on cross-site POSTs.
- In addition, the guard rejects any state-changing request whose `Origin` header is present and
  not in `API_CORS_ORIGINS`. This also blocks forged sign-ins ("login CSRF"), which cookies alone
  do not. Native clients send no `Origin` and are unaffected.

## 7. Audit

Written as platform events (`organisation_id` NULL) in the same transaction as the change:

| Action | Actor | Metadata |
| ------ | ----- | -------- |
| `auth.sign_up` | new user | `client` |
| `auth.sign_in` | user | `client` |
| `auth.sign_in_failed` | user, or null for an unknown email | `reason`: `wrong_password`, `unknown_account`, `account_disabled` |
| `auth.sign_out` | user | |

No passwords, hashes, tokens or attempted email addresses are written to audit records or logs.
Platform audit rows are hidden from tenants and from both application roles by row-level
security; platform tooling reads them.

## 8. Known gaps (tracked in the roadmap)

- **MFA** for privileged roles, **email verification**, **password reset** and **breached-password
  screening** are not built yet. Required before privileged customer users go live.
- **Sign-up reveals registered emails** (`409`). The fix (always answer "check your email") needs
  email verification. Mitigated by the per-IP sign-up limit.
- No "sign out everywhere" or session list yet; signing in again does not revoke an older
  session on the same browser (it expires on its own).
- Rate-limited attempts are not audited (to keep floods out of the audit log); add a metric.
- Per-IP limits may need tuning for offices where many staff share one public IP.

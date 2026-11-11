# Threat Model

> Status: baseline. Review before each release stage and whenever a new integration, data
> category or surface is added. Controls detail lives in [SECURITY_PRIVACY](SECURITY_PRIVACY.md).

## Assets

Resident identity and contact data, property relationships (ownership, tenancy), visitor and
access logs, financial records and payment flows, incident records and evidence, identity
documents and other uploaded files, credentials and tokens, audit logs, and backups.

## Actors

Anonymous internet users, authenticated users of another tenant, authenticated users exceeding
their role or scope, malicious or careless insiders (staff, support), compromised third-party
integrations, and compromised dependencies.

## Threats and mitigations

| # | Threat | Primary mitigations | Where |
| - | ------ | ------------------- | ----- |
| T1 | Cross-organisation or cross-property data exposure | Route-derived tenant context + membership check; tenant-scoped repositories; composite tenant FKs; PostgreSQL RLS; per-route cross-tenant tests | [MULTI_TENANCY](../architecture/MULTI_TENANCY.md) |
| T2 | Privilege escalation, role misuse | Default deny; permission per route with boot-time check; cannot grant permissions you lack; scope inheritance downward only | [ACCESS_CONTROL](ACCESS_CONTROL.md) |
| T3 | Account takeover | Built-in auth with argon2id and hashed session tokens (ADR 0005), replaceable by an OIDC provider; MFA for privileged roles; session expiry and revocation; rate-limited auth and invitation endpoints | Phase 2 |
| T4 | Visitor pass reuse or forgery | Random 256-bit QR tokens and 8-character codes stored only as SHA-256 hashes; time-limited, revocable, per-property; validated server-side under a row lock; 60 checks per guard per minute; a pass is never proof of identity | Phase 5 (done) |
| T4b | Stale offline access at the gate | Offline lists cover 4 hours ahead and are refused after 4 hours; they hold hashes, never codes; entries synced later are re-checked at the time they happened and flagged for supervisor review; walk-ins to a unit are impossible offline. Residual risk: a lost gate phone exposes names, plates and unit numbers for up to 4 hours ahead, and short codes could be brute-forced from their hashes within that window, so lost devices are reported and passes re-issued ([GATE_OFFLINE](../operations/GATE_OFFLINE.md)) | Phase 5 (done) |
| T5 | Payment replay, forged callbacks, duplicate processing | Signature verification over the raw body with a 5-minute window before anything is read; idempotency on provider event ID (unique key) and on the client Idempotency-Key for manual payments; amount and currency must match the intent; never trust browser redirects (only the signed callback records a payment); independent reconciliation (later) | Phase 6 (implemented in Part 3 for the sandbox adapter) |
| T6 | Unauthorised access to identity documents and incident records | Separate permissions, access logging on reads, signed short-lived URLs after authorisation | Phases 4, 10, 11 |
| T7 | Malicious file uploads, unsafe sharing | Type/size limits, malware scanning, private storage, tenant-prefixed keys, signed URLs | Phase 10 |
| T8 | Insider misuse, untracked support access | Append-only audit log; break-glass support access with approval, expiry, reason, tenant visibility; finance maker-checker: payment reversals, refunds, write-offs and reopening a closed period need a second person (database CHECK and action triggers), posted ledger entries, payments and credits never change | Phases 2, 6, 13 |
| T9 | API abuse, scraping, denial of service | Edge WAF/CDN; Redis-backed rate limits by identity, tenant and endpoint risk; pagination limits | Phase 2 |
| T10 | Data loss, ransomware, misconfigured backups | Encrypted automated backups, restore drills, separated prod/dev data, monitored backup success | Operations |
| T11 | Compromised third-party integration | Adapters isolate provider payloads; least-privilege credentials per integration; webhook verification; SSRF protection on URL fetches | Phase 12 |
| T12 | Sensitive data in logs or errors | Error envelope hides internals (tested); log redaction; no tokens, secrets or full identity numbers logged | Phase 1 (errors), Phase 2 (logging) |
| T13 | Vulnerable dependencies, leaked secrets | Dependency and secret scanning in CI; secrets in a secrets manager, never in the repo | CI (to add) |

## Already implemented (Phase 1, pending test run)

- T12: API error filter returns a generic 500 envelope; a test asserts that internal hostnames
  and secrets in exception messages are not exposed. Env validation errors list variable names
  only.
- T1 foundation: `withTenantTransaction` sets `app.organisation_id` as a bound parameter and
  refuses invalid tenants; the worker rejects tenant-less jobs that are not declared platform jobs.
- Security headers (helmet, Next.js headers) and CORS allow-list.

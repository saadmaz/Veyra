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
| T3 | Account takeover | Managed OIDC provider; MFA for privileged roles; session expiry and revocation; rate-limited auth and invitation endpoints | Phase 2 |
| T4 | Visitor pass reuse or forgery | Random, time-limited, revocable passes scoped to property/visit; server-side validation; pass is not proof of identity | Phase 5 |
| T5 | Payment replay, forged callbacks, duplicate processing | Signature verification; idempotency on provider event ID; never trust browser redirects; independent reconciliation | Phase 6 |
| T6 | Unauthorised access to identity documents and incident records | Separate permissions, access logging on reads, signed short-lived URLs after authorisation | Phases 4, 10, 11 |
| T7 | Malicious file uploads, unsafe sharing | Type/size limits, malware scanning, private storage, tenant-prefixed keys, signed URLs | Phase 10 |
| T8 | Insider misuse, untracked support access | Append-only audit log; break-glass support access with approval, expiry, reason, tenant visibility | Phases 2, 13 |
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

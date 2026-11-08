# Phase 2 exit review: Identity and multi-tenancy

- **Date:** 2026-11-08
- **Scope:** PRs #5 (data foundation), #6 (authentication), #9 (tenancy and authorisation),
  #10 (console UI)
- **Decision:** Phase 2 is complete for organisation-level tenancy. Proceed to Phase 3. The
  open items below are tracked; none blocks Phase 3, and the items marked "before pilot" must
  be closed before real customer data is stored.

## 1. Exit gate

Stage 1 exit gate (ROADMAP): *automated tests prove one organisation/property cannot access
another's protected data*.

| Part of the gate | Status | Evidence |
| ---------------- | ------ | -------- |
| Organisation isolation, database layer | ✅ | `packages/db/test/integration/rls.int.test.ts`: no context sees nothing, tenant A cannot read, insert into, update or move rows into tenant B, FORCE RLS binds the owner |
| Organisation isolation, API layer | ✅ | `apps/api/test/integration/organisations.int.test.ts`: every organisation route returns 404 to non-members (parameterised), unknown and malformed ids behave the same |
| Property isolation | ⏳ Phase 3 | Properties do not exist yet. Composite tenant foreign keys and property-scoped grants arrive with them |

## 2. Required tests (ACCESS_CONTROL section 5, MULTI_TENANCY section 7)

| Requirement | Status |
| ----------- | ------ |
| Cross-organisation access through every endpoint | ✅ API integration |
| Query without tenant context returns no rows | ✅ DB integration |
| Expired, future-dated and revoked memberships denied | ✅ unit + API integration |
| Revocation during an active session applies on the next request | ✅ API integration |
| Privilege escalation (cannot grant more than you hold) | ✅ unit (policy with synthetic roles); API returns 403 for a finance officer. A real role that can invite but not everything does not exist yet, so the end-to-end escalation path is unit-tested only |
| Every route declares its access (startup check) | ✅ unit |
| Jobs without tenant context rejected | ✅ worker unit (Phase 1) |
| Cross-property access (manager of P1 vs P2) | ⏳ Phase 3 |
| Composite FK rejects cross-tenant parent | ⏳ Phase 3 |
| Exports contain only the tenant's data | ⏳ Phase 12 |

## 3. Verification at the time of review

| Suite | Result |
| ----- | ------ |
| Lint, typecheck (18 workspaces), build (12) | ✅ |
| Unit tests | ✅ 165 (API 93, console 21, domain 20, db 9, worker 6, other packages 16) |
| Integration, real PostgreSQL 17 | ✅ db 34, API 37; plus 5 Redis tests that run in CI |
| Browser journeys (Playwright, desktop and phone) with axe WCAG 2.2 AA | ✅ 22 |
| CI on every PR (`verify`, required to merge) | ✅ PRs #5, #6, #9, #10 green before merge |

Defects found and fixed during the phase: Prisma reading `timestamptz` with the wrong offset
under a non-UTC database (sessions would have expired hours late); intermittent Windows test
teardown failures; an organisation switcher that did not refresh after creating an organisation.

## 4. Security review

| Area | Assessment |
| ---- | ---------- |
| Tenant isolation | Three layers in place: route-derived tenant and membership check, explicit `organisation_id` filters, PostgreSQL RLS with FORCE and a non-bypass application role |
| Authentication | argon2id, hashed opaque tokens bound to transport, idle and absolute expiry, rate limits that fail closed, CSRF Origin check, audit. See gaps below |
| Authorisation | Deny by default at two global guards and at startup; 404 for non-members; anti-escalation; last-admin protection |
| Secrets and data in logs | No passwords, hashes or tokens in responses, audit metadata or error envelopes (tested). Structured logging is not in place yet, so log hygiene is not systematically enforced |
| Dependencies | Dependabot version updates (grouped) and security alerts enabled. No secret scanning yet |

## 5. Open items

### Before the first pilot stores real customer data

1. **MFA for privileged users, email verification, password reset, breached-password check**
   (ADR 0005). Email verification also closes sign-up email enumeration and the
   "invitation accepted by an unverified address" gap.
2. **Structured JSON logging** with request ids and redaction (planned for Phase 2, not done).
3. **Secret scanning** in CI (for example gitleaks), since GitHub secret scanning needs a paid
   plan on private repositories.
4. **Content-Security-Policy** for the console.
5. **Production database roles** created from a secrets manager (currently development script
   only), and backups with a tested restore.
6. **Full-stack smoke test**: console + API + PostgreSQL + Redis together. Docker Compose has
   never been run on the development machine.

### Can wait

- Expired-session cleanup job; outbox relay (table exists, nothing writes to it yet).
- Console: membership actions and organisation settings form; localisation framework.
- Permission cache with invalidation (only if measurements require it).
- Module-boundary lint rule (modules import each other through `index.ts` by convention).

## 6. Documentation

Up to date: ADRs 0005 and 0006; AUTHENTICATION, ACCESS_CONTROL (section 6), MULTI_TENANCY
(section 3), DATA_MODEL, API_DESIGN, TESTING_STRATEGY, DEVELOPMENT_SETUP, ROADMAP, CHANGELOG.

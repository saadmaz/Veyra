# VEYRA — Master AI Engineering Build Prompt

Copy this prompt into your coding agent after placing the VEYRA blueprint in the repository. The agent must inspect the actual repository and work incrementally. This is not an instruction to generate the entire platform in one pass.

---

## ROLE

Act as the principal software architect, staff-level full-stack engineer, security engineer, product-minded technical lead, and quality owner for **VEYRA**, a global property and community operations SaaS platform.

You are responsible for helping design, implement, test, document, and evolve a secure enterprise product. Think like an engineering team building a long-lived commercial platform—not a prototype, hackathon project, or collection of disconnected CRUD screens.

## PRODUCT

VEYRA is a unified operating system for condominiums, apartment buildings, gated communities, residential estates, and property management organisations.

Brand:
- Name: VEYRA
- Positioning: Intelligent Living. Unified Operations.
- Product promise: one secure platform for property operations, resident services, access, finance, maintenance, facilities, communications, and management intelligence.

Product surfaces:
1. VEYRA Console — management web application.
2. VEYRA Resident — resident mobile application.
3. VEYRA Operations — staff/security responsive application.
4. VEYRA APIs and integrations.

## FIRST: INSPECT, DO NOT ASSUME

Before writing code:
1. Inspect repository structure, git status, current branch, package manager, lockfiles, existing scripts, application state, tests, and deployment configuration.
2. Read `README.md`, `AGENTS.md`, and all relevant documentation under `docs/`.
3. Identify what is implemented, partially implemented, missing, broken, or unsafe.
4. Run existing checks where practical and report the baseline.
5. Produce a concise architecture and implementation assessment.
6. Do not overwrite existing working code or remove files without explaining why and obtaining approval for destructive changes.

If the repository is empty, propose and then create the minimum coherent monorepo foundation. If it already has a stack, prefer the existing stack unless a documented technical reason justifies changing it.

## PROPOSED DEFAULT STACK

Use these defaults only if the repository does not already establish alternatives:

- Monorepo: Bun workspaces + Turborepo
- Web: Next.js, React, TypeScript
- Mobile: React Native + Expo (see ADR 0004)
- Backend: NestJS, TypeScript
- Database: PostgreSQL
- ORM: Prisma, with reviewed SQL migrations
- Cache and jobs: Redis + BullMQ
- API: REST + OpenAPI
- Authentication: OIDC-compatible identity provider
- Files: S3-compatible object storage
- Realtime: WebSockets or SSE when justified
- Testing: Vitest, Playwright, jest-expo + React Native Testing Library, Maestro for device E2E
- Observability: OpenTelemetry and error tracking
- Delivery: Docker and GitHub Actions

Do not add every technology on day one. Choose the simplest production-suitable option for the current requirement.

## ARCHITECTURAL RULES

1. Begin with a modular monolith, not microservices.
2. Separate domain, application, infrastructure, and presentation concerns where useful.
3. Keep modules cohesive and avoid circular dependencies.
4. Each module owns its business rules and persistence operations.
5. Communicate across modules through explicit application interfaces or domain events.
6. Use PostgreSQL as the system of record.
7. Use transactions for business invariants.
8. Use an outbox and idempotent consumers for reliable asynchronous work where needed.
9. Use provider adapters for payments, email, SMS, push, access devices, accounting, and identity.
10. Keep public API contracts separate from database models.
11. Version APIs and document them with OpenAPI.
12. Design for future service extraction without operating microservices prematurely.

## GLOBAL MULTI-TENANCY

VEYRA must support multiple customer organisations and multiple properties per organisation.

Conceptual hierarchy:

Platform → Organisation → Property → Building → Floor → Unit.

Requirements:
- A user may belong to multiple organisations/properties.
- A user may hold multiple roles.
- A person profile is not the same thing as a login account.
- Owner, tenant, household member, committee member, staff member, and vendor relationships must be represented explicitly.
- Relationships can have effective start/end dates.
- A tenant's access must be revocable at move-out.
- Every customer-owned record must have enforceable tenant scope.
- Resolve tenant context from authenticated memberships and server-side policy.
- Never trust a client-supplied organisation/property ID as proof of authority.
- Test cross-tenant access attempts for every protected module.
- Consider PostgreSQL row-level security as defence in depth only with carefully tested connection and transaction context.

## SECURITY REQUIREMENTS

Treat resident, visitor, identity, finance, incident, and access information as sensitive.

- Default deny and least privilege.
- Use RBAC plus resource/scope-based authorisation.
- Enforce access on the server for every protected request.
- MFA for privileged users.
- Secure invitation, recovery, session expiry, and revocation.
- Validate all external provider callbacks.
- Use idempotency for payments and retryable side effects.
- Never store raw payment card details.
- Keep posted financial ledger entries immutable; correct them through reversals.
- Use encryption in transit and at rest.
- Protect file uploads and signed URLs.
- Do not log secrets or unnecessary personal data.
- Audit privileged actions and sensitive data access.
- Add rate limiting, input validation, security headers, dependency scanning, and secret scanning.
- Do not introduce biometrics or facial recognition without a separate legal and privacy assessment.
- Build backup, restore, incident response, and rollback procedures.

## PRODUCT MODULES

Implement modules incrementally according to the approved PRD and roadmap:

1. Organisation and property hierarchy
2. Identity, memberships, roles, and permissions
3. Residents, owners, tenants, household members
4. Buildings, floors, units, parking, vehicles
5. Visitor invitations, passes, check-in/out, access logs
6. Finance: charges, invoices, payments, allocations, receipts, reconciliation, ledger
7. Maintenance requests, work orders, SLA and escalation
8. Facilities and reservations
9. Staff, shifts, tasks, inspections and handovers
10. Assets and preventive maintenance
11. Vendors and contracts
12. Procurement and approvals
13. Announcements and notifications
14. Documents and records
15. Incidents and emergency operations
16. Committee, meetings, resolutions and governance
17. Reporting and analytics
18. Integrations and later AI-assisted insights

Do not create empty modules or build every module at once. Deliver vertical slices with real workflows.

## DESIGN AND USER EXPERIENCE

Build a premium, calm, trustworthy enterprise product.

- Use a consistent design system and semantic design tokens.
- Avoid generic template-like dashboards and excessive gradients.
- Prioritise information hierarchy, legibility, density appropriate to operational work, and clear status communication.
- Responsive web layouts for desktop, tablet, and mobile.
- Resident experiences should be simple and task-oriented.
- Security interfaces should support fast, low-error gate workflows.
- Finance interfaces should emphasise correctness, reconciliation, and traceability.
- Include loading, empty, error, denied, and success states.
- Meet WCAG 2.2 AA as a target.
- Support localisation, currencies, date formats, and property time zones.
- Do not hardcode a single country's assumptions into shared domain logic.

## DATA AND DOMAIN RULES

- Use UUID or ULID consistently for identifiers.
- Use explicit foreign keys and tenant-aware unique constraints.
- Use UTC timestamps and property IANA time zones.
- Money must never use binary floating point. Use integer minor units or a validated decimal representation and always store currency.
- Do not assume all currencies have two decimal places.
- Use validated state transitions, not arbitrary status updates.
- Preserve financial history.
- Store file bytes in object storage and metadata/access rules in PostgreSQL.
- Define retention and deletion policies.
- Do not seed real resident information.

## QUALITY AND TESTING

For each feature:
- Unit test domain rules.
- Integration test database constraints and transactions.
- Test authorised and unauthorised access.
- Test cross-tenant and cross-property isolation.
- Test state transitions and edge cases.
- Contract-test integrations.
- End-to-end test critical user journeys.
- Test retries, idempotency, and provider failure paths where applicable.
- Test responsive and accessible user flows.

Run formatting, lint, typecheck, tests, and builds for affected workspaces. Do not claim checks passed unless you ran them and observed the result.

## REQUIRED DELIVERY PROCESS

Work in small, reviewable phases.

For each task:
1. State objective and acceptance criteria.
2. Inspect impacted code and documentation.
3. Identify data, permission, API, migration, UI, integration, and operational impacts.
4. Propose a short plan.
5. Implement the smallest complete vertical slice.
6. Add tests.
7. Run relevant checks.
8. Review the diff for security, tenant isolation, data integrity, accessibility, and performance.
9. Update docs and ADRs.
10. Report changed files, test evidence, limitations, and next steps.

Never:
- Generate the whole application in one enormous response.
- Fake integrations or claim a payment/access device works without a real adapter and test evidence.
- Add mock data to production flows.
- Bypass permissions for convenience.
- Use client-side checks as the only security control.
- Introduce microservices or infrastructure complexity without an ADR.
- Perform destructive migrations without a safe rollout plan.
- Expose secrets or personal data.
- Claim production readiness without security, recovery, monitoring, and operational validation.

## INITIAL EXECUTION TASK

Start with a repository assessment and foundation plan. Do not immediately implement all product features.

Return:
1. Current repository assessment.
2. Proposed target architecture based on what actually exists.
3. Prioritised implementation backlog.
4. Risks and decisions requiring product-owner input.
5. First vertical slice and its acceptance criteria.
6. Exact commands you recommend running and why.

After approval, implement the foundation and then proceed through the roadmap.

The first vertical slice should generally be:
- Organisation and property provisioning
- Authentication integration
- Membership and scoped authorisation
- Building/floor/unit hierarchy
- Audit events
- Tenant-isolation tests

This foundation must be proven before resident, visitor, finance, or maintenance modules depend on it.

## DEFINITION OF DONE

A feature is done only when:
- Acceptance criteria are met.
- Business rules are implemented server-side.
- Permissions and tenant boundaries are tested.
- Data migrations are safe and reviewed.
- Errors and retries are handled.
- Tests and quality gates pass.
- Logs and metrics are adequate.
- Documentation is updated.
- Known limitations are stated.

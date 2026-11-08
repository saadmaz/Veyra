# VEYRA

**Intelligent Living. Unified Operations.**

VEYRA is a global property and community operations platform for condominiums, apartments,
gated communities, residential estates and property management organisations.

It brings resident services, property administration, access management, facilities,
maintenance, finance, communications, governance, vendors and operational intelligence into
one secure, multi-tenant platform.

> Product ambition: a dependable operating system for residential communities, not a collection
> of disconnected forms and dashboards.

## Product principles

1. **Multi-tenant by design:** many organisations and properties with enforceable data isolation.
2. **Security and privacy by default:** least privilege, auditable actions, secure identity.
3. **Modular architecture:** strong domain boundaries in a modular monolith first.
4. **Global readiness:** currencies, locales, time zones, languages, jurisdiction-specific policies.
5. **Operational reliability:** observable systems, tested recovery, safe deployments.
6. **Accessible and inclusive UX:** responsive, keyboard-friendly, WCAG 2.2 AA target.
7. **API-first integration:** documented contracts for payments, access hardware, accounting, messaging.

## Product surfaces

- **VEYRA Console:** web app for organisation admins, property managers, finance, committee and operations.
- **VEYRA Resident:** Flutter mobile app for owners, tenants and household members.
- **VEYRA Operations:** responsive staff/security experience (PWA first) for visitors, incidents,
  inspections and work orders.
- **Platform APIs:** versioned REST APIs and integration interfaces.

## Technology baseline

| Area | Choice |
| ---- | ------ |
| Monorepo | Bun workspaces + Turborepo |
| Language | TypeScript (strict) |
| Web | Next.js + React |
| Mobile | Flutter |
| Backend | NestJS modular monolith (API + worker processes) |
| Database | PostgreSQL + Prisma (reviewed SQL migrations) |
| Cache / jobs | Redis + BullMQ |
| API | REST + OpenAPI |
| Authentication | OIDC-compatible identity provider |
| Files | S3-compatible object storage |
| Lint / format | Biome |
| Tests | Vitest, Supertest, Playwright, Flutter test |
| Observability | OpenTelemetry + Sentry-compatible error tracking |
| Delivery | Docker + GitHub Actions |

Rationale: [ADR 0001](docs/adr/0001-modular-monolith.md), [ADR 0002](docs/adr/0002-multi-tenancy.md),
[ADR 0003](docs/adr/0003-tooling-baseline.md).

## Repository

```
apps/api        NestJS HTTP API (/api/v1)
apps/worker     BullMQ background worker
apps/web        Next.js web app (becomes VEYRA Console)
packages/domain Shared kernel: Money, TenantContext, JobEnvelope, DomainError
packages/db     Prisma schema, client factory, tenant transaction helper
docs/           Product, architecture, security, engineering, operations, ADRs
```

Current and target layouts: [Repository structure](docs/engineering/REPOSITORY_STRUCTURE.md).

## Getting started

Prerequisites: Bun 1.4+, Node.js 24+, Docker. The repository must be on an NTFS (or other
link-capable) filesystem: Bun workspaces need symlinks, which exFAT/FAT drives do not support.

```powershell
bun install
Copy-Item .env.example .env
bun run services:up      # PostgreSQL + Redis
bun run dev
bun run lint
bun run typecheck
bun run test
```

Full guide: [Development setup](docs/engineering/DEVELOPMENT_SETUP.md).

## Documentation

- Product: [Vision](docs/product/PRODUCT_VISION.md) · [PRD](docs/product/PRD.md) ·
  [Roadmap](docs/product/ROADMAP.md) · [Personas](docs/product/USER_PERSONAS.md) ·
  [Journeys](docs/product/USER_JOURNEYS.md)
- Architecture: [Architecture](docs/architecture/ARCHITECTURE.md) ·
  [Data model](docs/architecture/DATA_MODEL.md) · [Multi-tenancy](docs/architecture/MULTI_TENANCY.md) ·
  [API design](docs/architecture/API_DESIGN.md)
- Security: [Security & privacy](docs/security/SECURITY_PRIVACY.md) ·
  [Threat model](docs/security/THREAT_MODEL.md) · [Access control](docs/security/ACCESS_CONTROL.md)
- Engineering: [Standards](docs/engineering/ENGINEERING_STANDARDS.md) ·
  [Repository structure](docs/engineering/REPOSITORY_STRUCTURE.md) ·
  [Testing strategy](docs/engineering/TESTING_STRATEGY.md)
- Decisions: [ADRs](docs/adr/)
- AI agents: [AGENTS.md](AGENTS.md) · [AI build prompt](docs/AI_BUILD_PROMPT.md)

## Development status

Foundation stage. See the [roadmap](docs/product/ROADMAP.md) for what is written, what is
verified and what is outstanding. This documentation describes intended product and
architecture; it is not evidence that features are implemented, security controls are
validated, or the platform is production-ready.

## Contribution workflow

- Short-lived branches from `main`: `feat/<ticket>-desc`, `fix/<ticket>-desc`, `chore/<desc>`.
- Focused changes with tests; pull request with CI passing and review before merge.
- Keep `main` protected.
- Update documentation and ADRs when behaviour or architecture changes.
- Never commit secrets, production data, personal data or credentials.

## Licence

No licence has been chosen. This repository is not open source.

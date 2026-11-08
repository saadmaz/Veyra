# Engineering Standards

## Code

- TypeScript `strict` with `noUncheckedIndexedAccess`. Explicit types at public boundaries.
- No `any` (lint error). Justify any unavoidable exception; no `@ts-ignore` without a linked issue.
- Biome is the formatter and linter. Never disable a rule globally to make a build pass.
- Small, cohesive modules and functions.
- Domain code (`packages/domain`, `modules/*/domain`) imports no framework, ORM or HTTP code.
- Business rules live in domain/application layers. Controllers and UI components orchestrate;
  they do not own business rules. No hidden side effects in ORM lifecycle hooks.
- Validate all external input at the boundary (Zod): HTTP body/query/params, env, webhooks,
  job payloads.
- Every protected endpoint declares its permission. Every tenant-owned query runs through the
  tenant transaction helper.
- Throw `DomainError` for business-rule violations. Never return raw provider/DB errors to clients.
- No secrets in code, logs, tests or fixtures.

## Naming

- kebab-case for folders and filenames; PascalCase for classes and React components; camelCase
  for variables and functions.
- Explicit domain names; avoid ambiguous abbreviations.
- API DTOs are separate from persistence models.

## API contracts

- Versioned public APIs with OpenAPI documentation.
- Request and response schemas validated.
- Consistent pagination, filtering, error envelope and correlation IDs
  (see [API_DESIGN](../architecture/API_DESIGN.md)).
- Idempotency for commands with side effects.
- Webhook authentication, retries and event schemas documented.

## Database

- All schema changes via reviewed migrations. Destructive changes (drop/rename column, type
  narrowing) use expand-and-contract across releases with a staged rollout plan.
- Foreign keys, constraints, tenant-scoped queries and tenant-scoped unique constraints.
- Transactions for invariants.
- Indexes based on query plans and real workload.
- Production data never appears in local fixtures.

## Money and time

- Money is always `Money` (bigint minor units + currency). Never JavaScript floats.
- Respect currency-specific minor units (JPY 0, USD 2, KWD 3).
- Persist timestamps in UTC. Each property stores an IANA time zone used for schedules and display.
- Test daylight-saving transitions for supported zones.

## Testing

See [TESTING_STRATEGY](TESTING_STRATEGY.md). Every behaviour change has tests, including negative
tests for denied and cross-tenant access. Deterministic fixtures and fake provider adapters.
Load tests for high-volume workflows before scale-up.

## Branches and pull requests

- `main` is protected. Branches: `feat/<ticket>-short-description`, `fix/<ticket>-short-description`,
  `chore/<short-description>`.
- Every PR includes: problem and context, scope and non-goals, implementation summary,
  screenshots for UI changes, test evidence, migration and rollout notes, security/privacy
  impact, operational impact, documentation changes.
- PRs need passing CI and review. Finance, identity, permission and tenant-isolation changes need
  an additional approval.
- Releases are tagged with a consistent versioning scheme. Environment configuration stays out
  of source control.

## CI quality gates

| Gate | Status |
| ---- | ------ |
| Format + lint (Biome) | In workflow |
| Typecheck | In workflow |
| Unit and API tests | In workflow |
| Build | In workflow |
| Prisma schema validation | In workflow |
| Integration tests against PostgreSQL/Redis | Phase 2 |
| Migration validation | Phase 2 |
| Dependency / security scanning | To add |
| Secret scanning | To add |
| End-to-end and container scanning | As the pipeline matures |

## Observability

- Structured logs with correlation (request) IDs; personal and secret data redacted.
- Metrics: request latency, error rate, queue depth, job failures, database health, provider failures.
- Distributed traces across API and workers (OpenTelemetry).
- Alerts tied to actionable runbooks.

## Documentation

- Update README for setup changes and the PRD for product behaviour changes.
- Add an ADR for material architectural decisions.
- Maintain API docs, operational runbooks and integration guides.
- Record known limitations and technical debt honestly in [ROADMAP](../product/ROADMAP.md).

## Definition of done

1. Acceptance criteria met; business rules implemented server-side.
2. `bun run lint`, `typecheck`, `test` and `build` pass locally and in CI.
3. Tests cover permissions, tenant boundaries, state transitions and failure paths where relevant.
4. Migrations are safe and reviewed; errors and retries are handled.
5. Logs and metrics are adequate; docs updated; known limitations stated.
6. No placeholder responses or fake data in production code paths.

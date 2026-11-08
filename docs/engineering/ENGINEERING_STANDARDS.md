# Engineering Standards

## Code

- TypeScript `strict`, `noUncheckedIndexedAccess`. No `any` (lint error). No `@ts-ignore` without
  a linked issue and comment.
- Biome is the formatter and linter. Never disable a rule globally to make a build pass.
- Domain code (`packages/domain`, `modules/*/domain`) imports no framework, ORM or HTTP code.
- Money is always `Money` (bigint minor units + currency). Never `number` for money.
- Timestamps are UTC `Date`/`timestamptz`. Local dates are computed with the property's IANA zone.
- Validate all external input at the boundary (Zod): HTTP bodies/query/params, env, webhooks, job payloads.
- Every protected endpoint declares its permission. Every tenant-owned query runs through the
  tenant transaction helper.
- Errors: throw `DomainError` for business-rule violations; never return raw provider/DB errors to clients.
- No secrets in code, logs, tests or fixtures. Use `.env` locally and a secrets manager in deployed environments.

## Changes

- Small vertical slices: domain + persistence + API + tests + docs in one change.
- Database changes go through Prisma migrations, reviewed by a human. Destructive changes
  (drop/rename column, type narrowing) use expand-and-contract across releases.
- Update the relevant `docs/` page and add an ADR for significant decisions.
- Record known shortcuts as technical debt in `docs/product/ROADMAP.md` under "Technical debt".

## Definition of done

1. `bun run lint`, `typecheck`, `test` and `build` pass locally and in CI.
2. New behaviour has tests, including permission and tenant-isolation cases where relevant.
3. Docs updated.
4. No placeholder responses or fake data in production code paths.

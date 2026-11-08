# ADR 0003: Tooling baseline

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

Phase 1 needs a monorepo with fast installs, task caching, consistent linting and
formatting, and a test runner shared across packages.

## Decision

| Concern | Choice | Reason |
| ------- | ------ | ------ |
| Package manager / workspaces | Bun | Specified in the brief; fast installs; workspace support. |
| Runtime for api/worker | Node.js LTS | NestJS, Prisma and BullMQ are tested primarily on Node. Bun is used as package manager and script runner, not as the production runtime, until compatibility is proven. |
| Task orchestration | Turborepo | Cached, dependency-aware `build`, `lint`, `typecheck`, `test`. |
| Lint + format | Biome | One fast tool instead of ESLint + Prettier + plugins; fewer dependencies. Revisit if a needed rule is missing (e.g. module-boundary rules may need dependency-cruiser). |
| Tests | Vitest everywhere (`unplugin-swc` for NestJS decorator metadata), Playwright for E2E | One runner and assertion API across packages. |
| Validation of config | Zod | Fail fast at boot on invalid environment. |
| Mobile | React Native + Expo (`apps/resident-mobile`) | Superseded the original Flutter choice; see [ADR 0004](0004-react-native-mobile.md). |

## Consequences

- Contributors need Bun and Node installed (see [DEVELOPMENT_SETUP](../engineering/DEVELOPMENT_SETUP.md)).
- CI installs both.

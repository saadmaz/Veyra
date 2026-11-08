## Problem and context

<!-- What problem does this solve? Link the issue. -->

## Scope

- In scope:
- Out of scope:

## Implementation summary

## Screenshots / recordings

<!-- Required for UI changes (web and mobile). -->

## Test evidence

<!-- Paste the commands you ran and their results. -->

- [ ] `bun run lint`
- [ ] `bun run typecheck`
- [ ] `bun run test`
- [ ] `bun run build`

## Checklist

- [ ] Permissions are checked on the server for every new or changed endpoint
- [ ] Tenant isolation covered by tests (cross-organisation / cross-property attempts)
- [ ] Money uses `Money`; timestamps are UTC; property time zones respected
- [ ] No secrets, real personal data or placeholder responses
- [ ] Loading, empty, error, permission-denied and success states handled (UI)
- [ ] Docs / ADRs updated

## Migration and rollout notes

<!-- Schema changes, data backfills, feature flags, rollback plan. Write "None" if not applicable. -->

## Security, privacy and operational impact

<!-- New data collected, new permissions, new external services, new jobs or alerts. -->

# Backup and restore runbook

PostgreSQL is the source of truth (AGENTS.md section 3): finance, access and the audit log live
there. Redis holds nothing that cannot be rebuilt. Object storage holds uploaded files.

## Targets (pilot)

| | Target |
| - | ------ |
| Recovery point objective | 5 minutes (point-in-time recovery from continuous WAL archiving) |
| Recovery time objective | 4 hours |
| Retention | 30 days of point-in-time recovery; monthly snapshots kept 12 months |
| Restore drill | Every month, and before each phase that changes finance or access tables |

## What to back up

1. **PostgreSQL:** the managed service's continuous backups with point-in-time recovery on. In
   addition, a daily logical backup (`pg_dump -Fc`) to a separate account, encrypted, so a
   problem with the provider is not a single point of failure.
2. **Object storage:** bucket versioning on, and a lifecycle rule keeping non-current versions
   for 30 days. Files are named by id (ADR 0007), so database restores and file versions line up.
3. **Secrets:** the secrets manager's own backup (`MFA_ENCRYPTION_KEY`, `WEBHOOK_SIGNING_KEY`,
   role passwords). Without `MFA_ENCRYPTION_KEY` a restored database cannot verify authenticator
   codes.

## Restoring a logical backup

Restore as a superuser with triggers disabled, so the guard triggers that number records and set
times on insert do not rewrite restored rows:

```sh
createdb -O veyra_owner veyra_restore
pg_restore -U <admin> -d veyra_restore --disable-triggers veyra.dump
```

Then point a staging API at it and run the smoke test before switching anything.

## The drill

`infra/scripts/restore-drill.sh` backs up the running database, restores it into a fresh one and
checks that every table has the same number of rows. CI runs it on every pull request against the
full-stack environment. The monthly drill does the same against a copy of production in staging,
records the time it took, and runs the smoke test against the restored copy.

## After a restore

- Writes since the restore point are lost: tell affected customers, using the audit log to see
  what changed.
- Outbox events that were relayed but whose effects are lost will not repeat; check webhook and
  notification deliveries around the restore point.
- Sessions issued after the restore point stop working; people sign in again.

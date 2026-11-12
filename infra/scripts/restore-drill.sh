#!/bin/sh
# Backup and restore drill (Phase 14 Part 4). Takes a logical backup of the running database,
# restores it into a fresh database and checks that every table has the same number of rows.
# Run against infra/compose/full-stack.yml after the smoke test (CI does), or adapt the
# connection for a staging restore drill (docs/operations/BACKUP_RESTORE.md).
set -eu

COMPOSE="docker compose -f infra/compose/full-stack.yml"
PSQL="$COMPOSE exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -qtA"

echo "Backing up veyra..."
$COMPOSE exec -T postgres pg_dump -U postgres -d veyra -Fc -f /tmp/veyra.dump

echo "Restoring into veyra_restore..."
$PSQL -d postgres -c "DROP DATABASE IF EXISTS veyra_restore"
$PSQL -d postgres -c "CREATE DATABASE veyra_restore OWNER veyra_owner"
# --disable-triggers (needs a superuser): the guard triggers that number records and set times
# on insert must not rewrite restored rows.
$COMPOSE exec -T postgres pg_restore -U postgres -d veyra_restore --disable-triggers /tmp/veyra.dump

# Row counts per table, as the superuser (row-level security does not hide rows from it).
COUNTS="SELECT string_agg(format('%s=%s', relname, n), ',' ORDER BY relname) FROM (
  SELECT c.relname, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint AS n
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r') t"

ORIGINAL=$($PSQL -d veyra -c "$COUNTS")
RESTORED=$($PSQL -d veyra_restore -c "$COUNTS")

if [ "$ORIGINAL" != "$RESTORED" ]; then
  echo "Restore drill FAILED: row counts differ"
  echo "original: $ORIGINAL"
  echo "restored: $RESTORED"
  exit 1
fi
TABLES=$(echo "$ORIGINAL" | tr ',' '\n' | wc -l)
echo "Restore drill passed: $TABLES tables, identical row counts."
$PSQL -d postgres -c "DROP DATABASE veyra_restore"

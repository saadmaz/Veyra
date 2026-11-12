import type { DbClient } from './client';

/** An outbox event ready to be relayed (ARCHITECTURE section 5). */
export interface OutboxEventRow {
  id: string;
  organisationId: string | null;
  type: string;
  payload: unknown;
  availableAt: Date;
  attempts: number;
}

/**
 * Claims up to `limit` unpublished events of the given types that are due, oldest first. Each
 * claim counts an attempt; concurrent relays never claim the same row (SKIP LOCKED) while its
 * transaction is open. The caller publishes them and then calls markOutboxPublished (or
 * markOutboxFailed): a relay that dies in between leaves them unpublished, so they are claimed
 * again later. Delivery is therefore at least once; consumers must be idempotent.
 */
export async function claimOutboxEvents(
  db: DbClient,
  types: readonly string[],
  limit: number,
): Promise<OutboxEventRow[]> {
  if (types.length === 0 || limit <= 0) return [];
  return db.$queryRaw<OutboxEventRow[]>`
    UPDATE "outbox_events" o
       SET "attempts" = o."attempts" + 1
      FROM (
        SELECT "id" FROM "outbox_events"
         WHERE "published_at" IS NULL AND "available_at" <= now() AND "type" = ANY(${[...types]}::text[])
         ORDER BY "available_at", "id"
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
      ) due
     WHERE o."id" = due."id"
    RETURNING o."id", o."organisation_id" AS "organisationId", o."type", o."payload",
              o."available_at" AS "availableAt", o."attempts"`;
}

/** Marks events relayed. Already published ones are left as they are. */
export async function markOutboxPublished(db: DbClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.$executeRaw`
    UPDATE "outbox_events" SET "published_at" = now(), "last_error" = NULL
     WHERE "id" = ANY(${[...ids]}::uuid[]) AND "published_at" IS NULL`;
}

/**
 * Records why an event could not be relayed and holds it back: retried after 30 seconds times
 * the number of attempts so far, at most an hour. The error text must not contain personal data.
 */
export async function markOutboxFailed(db: DbClient, id: string, error: string): Promise<void> {
  await db.$executeRaw`
    UPDATE "outbox_events"
       SET "last_error" = left(${error}, 500),
           "available_at" = now() + make_interval(secs => least(3600, 30 * "attempts"))
     WHERE "id" = ${id}::uuid AND "published_at" IS NULL`;
}

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Notifications (migration 20261124090000_notifications): notifications never change except
 * being read once by their recipient; each delivery starts pending and writes an outbox event for
 * the worker in the same transaction; the application cannot update deliveries, outcomes go
 * through app_notification_delivery_result() (attempts counted, FAILED after the last, final
 * states left alone, only the caller's tenant). Runs as veyra_app.
 */

let app: pg.Pool;

const ids = {
  org: randomUUID(),
  otherOrg: randomUUID(),
  resident: randomUUID(),
  other: randomUUID(),
};

async function inTenant<T>(
  org: string,
  work: (c: pg.PoolClient) => Promise<T>,
  user: string = ids.resident,
): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [org]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [user]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
const asOrg = <T>(work: (c: pg.PoolClient) => Promise<T>, user?: string) =>
  inTenant(ids.org, work, user);

async function notify(c: pg.PoolClient) {
  const id = randomUUID();
  const delivery = randomUUID();
  await c.query(
    `INSERT INTO notifications (id, organisation_id, user_id, kind, title, body, link)
     VALUES ($1, $2, $3, 'facility.booking.approved', 'Booking approved', 'Your hall booking is confirmed.', '/x')`,
    [id, ids.org, ids.resident],
  );
  await c.query(
    `INSERT INTO notification_deliveries (id, organisation_id, notification_id, channel, updated_at)
     VALUES ($1, $2, $3, 'EMAIL', now())`,
    [delivery, ids.org, id],
  );
  return { id, delivery };
}

const result = (delivery: string, sent: boolean, org = ids.org) =>
  inTenant(org, async (c) => {
    const { rows } = await c.query(
      `SELECT app_notification_delivery_result($1, $2, $3, $4, 3) AS status`,
      [delivery, sent, sent ? 'msg-1' : null, sent ? null : 'SMTP timeout'],
    );
    return rows[0].status as string;
  });

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 4 });
  for (const id of [ids.resident, ids.other]) {
    await app.query(
      `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, 'Person', now())`,
      [id, `note-${id}@example.test`],
    );
  }
  for (const org of [ids.org, ids.otherOrg]) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `nt-${org.slice(0, 8)}`],
      ),
    );
  }
});

afterAll(async () => {
  await app?.end();
});

describe('notifications', () => {
  it('are read once by their recipient and never change otherwise', async () => {
    const { id } = await asOrg(notify);
    await expect(
      asOrg(
        (c) => c.query(`UPDATE notifications SET read_at = now() WHERE id = $1`, [id]),
        ids.other,
      ),
    ).rejects.toThrow(/only the recipient/);
    await expect(
      asOrg((c) => c.query(`UPDATE notifications SET title = 'x' WHERE id = $1`, [id])),
    ).rejects.toThrow(/never changes/);
    await asOrg((c) => c.query(`UPDATE notifications SET read_at = now() WHERE id = $1`, [id]));
    await expect(
      asOrg((c) =>
        c.query(
          `INSERT INTO notifications (id, organisation_id, user_id, kind, title, body)
                             VALUES ($1, $2, $3, 'Bad Kind', 't', 'b')`,
          [randomUUID(), ids.org, ids.resident],
        ),
      ),
    ).rejects.toThrow(/notifications_text/);
  });
});

describe('deliveries', () => {
  it('hand themselves to the worker through the outbox and cannot be updated by the application', async () => {
    const { delivery } = await asOrg(notify);
    const { rows } = await app.query(
      `SELECT organisation_id, payload FROM outbox_events WHERE type = 'notification.delivery.due' AND payload->>'deliveryId' = $1`,
      [delivery],
    );
    expect(rows).toEqual([{ organisation_id: ids.org, payload: { deliveryId: delivery } }]);
    await expect(
      asOrg((c) =>
        c.query(`UPDATE notification_deliveries SET status = 'SENT' WHERE id = $1`, [delivery]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('count attempts, fail after the last one, and leave finished deliveries alone', async () => {
    const failing = (await asOrg(notify)).delivery;
    expect(await result(failing, false)).toBe('PENDING');
    expect(await result(failing, false)).toBe('PENDING');
    expect(await result(failing, false)).toBe('FAILED');
    expect(await result(failing, true)).toBe('FAILED');
    const ok = (await asOrg(notify)).delivery;
    expect(await result(ok, true)).toBe('SENT');
    const row = await asOrg(
      async (c) =>
        (
          await c.query(
            `SELECT attempts, provider_reference, sent_at, last_error FROM notification_deliveries WHERE id = $1`,
            [ok],
          )
        ).rows[0],
    );
    expect(row).toMatchObject({ attempts: 1, provider_reference: 'msg-1', last_error: null });
    expect(row.sent_at).not.toBeNull();
    // Another organisation cannot record an outcome.
    const theirs = (await asOrg(notify)).delivery;
    await expect(result(theirs, true, ids.otherOrg)).rejects.toThrow(/no such delivery/);
  });
});

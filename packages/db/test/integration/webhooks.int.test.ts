import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Webhooks (migration 20261129090000_webhooks): endpoints use HTTPS to public host names and
 * rotate secrets forward only; deliveries go only to active endpoints subscribed to the event,
 * each with an outbox event; outcomes are written only through app_webhook_delivery_result(),
 * which counts attempts and leaves settled deliveries alone; tenant-isolated.
 */

let app: pg.Pool;
const ids = {
  org: randomUUID(),
  otherOrg: randomUUID(),
  prop: randomUUID(),
  manager: randomUUID(),
};

async function inTenant<T>(org: string, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [org]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [ids.manager]);
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
const asOrg = <T>(work: (c: pg.PoolClient) => Promise<T>) => inTenant(ids.org, work);

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 2 });
  await app.query(
    `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, 'Manager', now())`,
    [ids.manager, `wh-${ids.manager}@example.test`],
  );
  for (const org of [ids.org, ids.otherOrg]) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `wh-${org.slice(0, 8)}`],
      ),
    );
  }
  await asOrg((c) =>
    c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Webhooks', 'WH', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    ),
  );
});

afterAll(async () => {
  await app?.end();
});

async function endpoint(url = 'https://hooks.example.test/veyra', events = ['incident.reported']) {
  const id = randomUUID();
  await asOrg((c) =>
    c.query(
      `INSERT INTO webhook_endpoints (id, organisation_id, url, events, created_by_user_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [id, ids.org, url, events, ids.manager],
    ),
  );
  return id;
}

const deliver = (endpointId: string, type = 'incident.reported') =>
  asOrg((c) =>
    c.query(
      `INSERT INTO webhook_deliveries (id, organisation_id, endpoint_id, event_type, event_id, payload)
       VALUES ($1, $2, $3, $4, $5, '{"ok":true}') RETURNING id`,
      [randomUUID(), ids.org, endpointId, type, randomUUID()],
    ),
  );

const result = (id: string, ok: boolean, code: number | null) =>
  asOrg((c) =>
    c.query(`SELECT app_webhook_delivery_result($1, $2, $3, $4, 2)::text AS status`, [
      id,
      ok,
      code,
      ok ? null : 'boom',
    ]),
  );

describe('webhooks', () => {
  it('take HTTPS endpoints on public host names, and rotate secrets forward only', async () => {
    for (const url of [
      'http://hooks.example.test/x',
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://db.internal/x',
    ]) {
      await expect(endpoint(url)).rejects.toThrow(/webhook_endpoints_shape/);
    }
    await expect(endpoint(undefined, [])).rejects.toThrow(/webhook_endpoints_shape/);
    const id = await endpoint();
    await asOrg((c) =>
      c.query(`UPDATE webhook_endpoints SET secret_version = 2 WHERE id = $1`, [id]),
    );
    await expect(
      asOrg((c) => c.query(`UPDATE webhook_endpoints SET secret_version = 1 WHERE id = $1`, [id])),
    ).rejects.toThrow(/forward/);
  });

  it('queue deliveries only to active, subscribed endpoints, with an outbox event each', async () => {
    const id = await endpoint();
    const d = (await deliver(id)).rows[0].id as string;
    const { rows } = await asOrg((c) =>
      c.query(
        `SELECT count(*)::int AS n FROM outbox_events WHERE type = 'webhook.delivery.due' AND payload->>'deliveryId' = $1`,
        [d],
      ),
    );
    expect(rows[0].n).toBe(1);
    await expect(deliver(id, 'approval_request.settled')).rejects.toThrow(
      /does not take this event/,
    );
    await deliver(id, 'webhook.test');
    await asOrg((c) =>
      c.query(`UPDATE webhook_endpoints SET status = 'DISABLED' WHERE id = $1`, [id]),
    );
    await expect(deliver(id)).rejects.toThrow(/disabled/);
  });

  it('record outcomes only through the function, counting attempts', async () => {
    const id = await endpoint();
    const d = (await deliver(id)).rows[0].id as string;
    await expect(
      asOrg((c) =>
        c.query(`UPDATE webhook_deliveries SET status = 'SUCCEEDED' WHERE id = $1`, [d]),
      ),
    ).rejects.toThrow(/permission denied/);
    expect((await result(d, false, 500)).rows[0].status).toBe('PENDING');
    expect((await result(d, false, null)).rows[0].status).toBe('FAILED');
    expect((await result(d, true, 200)).rows[0].status).toBe('FAILED');
    const ok = (await deliver(id)).rows[0].id as string;
    expect((await result(ok, true, 204)).rows[0].status).toBe('SUCCEEDED');
    const { rows } = await asOrg((c) =>
      c.query(
        `SELECT attempts, last_status_code, delivered_at IS NOT NULL AS done FROM webhook_deliveries WHERE id = $1`,
        [ok],
      ),
    );
    expect(rows[0]).toEqual({ attempts: 1, last_status_code: 204, done: true });
  });

  it('are invisible to another organisation and never deleted', async () => {
    const { rows } = await inTenant(ids.otherOrg, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM webhook_endpoints)::int AS e, (SELECT count(*) FROM webhook_deliveries)::int AS d`,
      ),
    );
    expect(rows[0]).toEqual({ e: 0, d: 0 });
    await expect(asOrg((c) => c.query(`DELETE FROM webhook_deliveries`))).rejects.toThrow(
      /permission denied/,
    );
  });
});

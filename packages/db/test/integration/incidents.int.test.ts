import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Incidents (migration 20261126090000_incidents): numbered per property, what was reported never
 * changes, statuses move only forward (or reopen from resolved), resolving needs an outcome,
 * closing needs every follow-up done, the timeline is written by the database and append-only,
 * actions are done once; tenant-isolated.
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
    [ids.manager, `inc-${ids.manager}@example.test`],
  );
  for (const org of [ids.org, ids.otherOrg]) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `in-${org.slice(0, 8)}`],
      ),
    );
  }
  await asOrg((c) =>
    c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Incidents', 'IN', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    ),
  );
});

afterAll(async () => {
  await app?.end();
});

async function incident(c: pg.PoolClient, over: { occurredAt?: string } = {}) {
  const { rows } = await c.query(
    `INSERT INTO incidents (id, organisation_id, property_id, category, severity, title, description, occurred_at,
       location_detail, reported_by_user_id, updated_at)
     VALUES ($1, $2, $3, 'SECURITY', 'HIGH', 'Gate forced', 'The side gate lock was broken.', $4, 'Side gate', $5, now())
     RETURNING id, incident_number`,
    [randomUUID(), ids.org, ids.prop, over.occurredAt ?? new Date().toISOString(), ids.manager],
  );
  return { id: rows[0].id as string, number: Number(rows[0].incident_number) };
}

const setStatus = (id: string, status: string, outcome: string | null = null) =>
  asOrg((c) =>
    c.query(`UPDATE incidents SET status = $2, outcome = $3 WHERE id = $1`, [id, status, outcome]),
  );

describe('incidents', () => {
  it('are numbered per property, start open, never in the future, and keep what was reported', async () => {
    const a = await asOrg((c) => incident(c));
    const b = await asOrg((c) => incident(c));
    expect(b.number).toBe(a.number + 1);
    await expect(
      asOrg((c) => incident(c, { occurredAt: new Date(Date.now() + 3_600_000).toISOString() })),
    ).rejects.toThrow(/cannot happen in the future/);
    await expect(
      asOrg((c) => c.query(`UPDATE incidents SET title = 'Something else' WHERE id = $1`, [a.id])),
    ).rejects.toThrow(/never changes/);
    await asOrg((c) =>
      c.query(`UPDATE incidents SET severity = 'CRITICAL', sensitive = true WHERE id = $1`, [a.id]),
    );
  });

  it('move through their statuses, log each change, and close only when every action is done', async () => {
    const { id } = await asOrg((c) => incident(c));
    await expect(setStatus(id, 'CLOSED')).rejects.toThrow(/cannot go from open to closed/);
    await setStatus(id, 'RESPONDING');
    await expect(setStatus(id, 'RESOLVED')).rejects.toThrow(/say how the incident ended/);
    await setStatus(id, 'RESOLVED', 'Lock replaced; police report filed.');
    await setStatus(id, 'RESPONDING');
    await setStatus(id, 'RESOLVED', 'Lock replaced; police report filed.');
    const action = randomUUID();
    await asOrg((c) =>
      c.query(
        `INSERT INTO incident_actions (id, organisation_id, property_id, incident_id, description)
         VALUES ($1, $2, $3, $4, 'Review CCTV')`,
        [action, ids.org, ids.prop, id],
      ),
    );
    await expect(setStatus(id, 'CLOSED')).rejects.toThrow(/finish the follow-up actions/);
    await asOrg((c) =>
      c.query(`UPDATE incident_actions SET done_at = now() WHERE id = $1`, [action]),
    );
    await expect(
      asOrg((c) =>
        c.query(
          `UPDATE incident_actions SET done_at = NULL, done_by_user_id = NULL WHERE id = $1`,
          [action],
        ),
      ),
    ).rejects.toThrow(/done once/);
    await setStatus(id, 'CLOSED');
    await expect(
      asOrg((c) => c.query(`UPDATE incidents SET severity = 'LOW' WHERE id = $1`, [id])),
    ).rejects.toThrow(/closed and no longer changes/);
    const { rows } = await asOrg((c) =>
      c.query(
        `SELECT kind, from_status, to_status FROM incident_updates WHERE incident_id = $1 ORDER BY sequence`,
        [id],
      ),
    );
    expect(rows.map((r) => r.to_status)).toEqual([
      'OPEN',
      'RESPONDING',
      'RESOLVED',
      'RESPONDING',
      'RESOLVED',
      'CLOSED',
    ]);
    await expect(
      asOrg((c) =>
        c.query(
          `INSERT INTO incident_updates (id, organisation_id, property_id, incident_id, kind, body, actor_user_id)
           VALUES ($1, $2, $3, $4, 'NOTE', 'Late note', $5)`,
          [randomUUID(), ids.org, ids.prop, id, ids.manager],
        ),
      ),
    ).rejects.toThrow(/incident is closed/);
  });

  it('keep a timeline only the database writes status changes to, and never edits', async () => {
    const { id } = await asOrg((c) => incident(c));
    await asOrg((c) =>
      c.query(
        `INSERT INTO incident_updates (id, organisation_id, property_id, incident_id, kind, body, actor_user_id)
         VALUES ($1, $2, $3, $4, 'NOTE', 'Guard on site.', $5)`,
        [randomUUID(), ids.org, ids.prop, id, ids.manager],
      ),
    );
    await expect(
      asOrg((c) =>
        c.query(
          `INSERT INTO incident_updates (id, organisation_id, property_id, incident_id, kind, to_status)
           VALUES ($1, $2, $3, $4, 'STATUS_CHANGED', 'CLOSED')`,
          [randomUUID(), ids.org, ids.prop, id],
        ),
      ),
    ).rejects.toThrow(/logged by the database/);
    await expect(
      asOrg((c) => c.query(`UPDATE incident_updates SET body = 'x' WHERE incident_id = $1`, [id])),
    ).rejects.toThrow(/append-only|permission denied/);
  });

  it('are invisible to another organisation and never deleted', async () => {
    const { rows } = await inTenant(ids.otherOrg, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM incidents)::int AS i, (SELECT count(*) FROM incident_updates)::int AS u,
                (SELECT count(*) FROM escalation_contacts)::int AS e`,
      ),
    );
    expect(rows[0]).toEqual({ i: 0, u: 0, e: 0 });
    await expect(asOrg((c) => c.query(`DELETE FROM incidents`))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('accept escalation contacts with a phone and a valid email only', async () => {
    const add = (email: string | null) =>
      asOrg((c) =>
        c.query(
          `INSERT INTO escalation_contacts (id, organisation_id, property_id, name, role, phone, email, categories, updated_at)
           VALUES ($1, $2, $3, 'City Fire Station', 'Fire brigade', '+92 21 111', $4, ARRAY['FIRE']::"IncidentCategory"[], now())`,
          [randomUUID(), ids.org, ids.prop, email],
        ),
      );
    await add('duty@fire.example.test');
    await expect(add('not an email')).rejects.toThrow(/escalation_contacts_text/);
  });
});

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Support access (migration 20261202090000_support_access): asked for only by platform admins
 * (a reason, 1-24 hours), decided by the organisation and never by the requester, approval opens
 * a window of the asked length, revocation ends it, every step is audited for the organisation,
 * and only the organisation and the requester see it.
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
    [ids.manager, `sa-${ids.manager}@example.test`],
  );
  for (const org of [ids.org, ids.otherOrg]) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `sa-${org.slice(0, 8)}`],
      ),
    );
  }
  await asOrg((c) =>
    c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Support', 'SA', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    ),
  );
});

afterAll(async () => {
  await app?.end();
});

const staff = randomUUID();

async function asUser<T>(userId: string, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
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

async function inOrgAs<T>(userId: string, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return asUser(userId, async (c) => {
    await c.query("SELECT set_config('app.organisation_id', $1, true)", [ids.org]);
    return work(c);
  });
}

const request = (hours = 2, reason = 'Customer asked about a missing invoice') =>
  asUser(staff, (c) =>
    c.query(`SELECT app_support_request($1, $2, $3) AS id`, [ids.org, reason, hours]),
  ).then((r) => r.rows[0].id as string);

const decide = (userId: string, id: string, status: string) =>
  inOrgAs(userId, (c) =>
    c.query(`UPDATE support_access SET status = $2 WHERE id = $1`, [id, status]),
  );

describe('support access', () => {
  beforeAll(async () => {
    await app.query(
      `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, 'Staff', now())`,
      [staff, `sup-${staff}@example.test`],
    );
    const owner = new pg.Client({ connectionString: inject('superuserDatabaseUrl') });
    await owner.connect();
    await owner.query(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [staff]);
    await owner.end();
  });

  it('is asked for only by platform admins, with a reason and at most 24 hours', async () => {
    await expect(
      asUser(ids.manager, (c) => c.query(`SELECT app_support_request($1, 'x', 1)`, [ids.org])),
    ).rejects.toThrow(/platform administrators only/);
    await expect(request(25)).rejects.toThrow(/support_access_shape/);
    await expect(request(2, '')).rejects.toThrow(/support_access_shape/);
    await expect(
      inOrgAs(ids.manager, (c) =>
        c.query(
          `INSERT INTO support_access (id, organisation_id, requested_by_user_id, reason, hours, updated_at)
           VALUES ($1, $2, $3, 'x', 1, now())`,
          [randomUUID(), ids.org, staff],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('is approved by the organisation, not the requester, and opens a window', async () => {
    const id = await request(3);
    await expect(decide(staff, id, 'APPROVED')).rejects.toThrow(
      /permission denied|not the requester/,
    );
    await decide(ids.manager, id, 'APPROVED');
    const { rows } = await asUser(staff, (c) =>
      c.query(
        `SELECT status, round(extract(epoch FROM ends_at - starts_at) / 3600)::int AS hours,
                decided_by_user_id = $2 AS by_org
           FROM support_access WHERE id = $1`,
        [id, ids.manager],
      ),
    );
    expect(rows[0]).toEqual({ status: 'APPROVED', hours: 3, by_org: true });
    await decide(ids.manager, id, 'REVOKED');
    await expect(decide(ids.manager, id, 'APPROVED')).rejects.toThrow(/cannot go from revoked/);
    const denied = await request();
    await decide(ids.manager, denied, 'DENIED');
    const audit = await asOrg((c) =>
      c.query(
        `SELECT action FROM audit_logs WHERE resource_type = 'support_access' ORDER BY created_at`,
      ),
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'support_access.requested',
      'support_access.approved',
      'support_access.revoked',
      'support_access.requested',
      'support_access.denied',
    ]);
  });

  it('is visible to its organisation and its requester only', async () => {
    const other = await inTenant(ids.otherOrg, (c) =>
      c.query(`SELECT count(*)::int AS n FROM support_access`),
    );
    expect(other.rows[0].n).toBe(0);
    const mine = await asUser(staff, (c) =>
      c.query(`SELECT count(*)::int AS n FROM support_access`),
    );
    expect(mine.rows[0].n).toBeGreaterThan(0);
  });
});

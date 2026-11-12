import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Platform administration (migration 20261201090000_platform_admin): platform admins read
 * organisations and subscriptions across tenants but no tenant data; plan and status changes go
 * only through functions that check the caller, need a reason and write the tenant's audit log;
 * granting is for the database owner only; revocation takes effect at once.
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
    [ids.manager, `pa-${ids.manager}@example.test`],
  );
  for (const org of [ids.org, ids.otherOrg]) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `pa-${org.slice(0, 8)}`],
      ),
    );
  }
  await asOrg((c) =>
    c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Platform', 'PA', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    ),
  );
});

afterAll(async () => {
  await app?.end();
});

const staff = randomUUID();

/** A transaction as a signed-in user with no organisation context (the platform's view). */
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

async function owner(sql: string, params: unknown[]) {
  const client = new pg.Client({ connectionString: inject('superuserDatabaseUrl') });
  await client.connect();
  try {
    await client.query(sql, params);
  } finally {
    await client.end();
  }
}

describe('platform administration', () => {
  beforeAll(async () => {
    await app.query(
      `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, 'Staff', now())`,
      [staff, `staff-${staff}@example.test`],
    );
    await owner(`INSERT INTO platform_admins (user_id, note) VALUES ($1, 'test')`, [staff]);
  });

  it('let platform admins read organisations and subscriptions, but no tenant data', async () => {
    const { rows } = await asUser(staff, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM organisations WHERE id = ANY($1))::int AS orgs,
                (SELECT count(*) FROM subscriptions WHERE organisation_id = ANY($1))::int AS subs,
                (SELECT count(*) FROM properties)::int AS props`,
        [[ids.org, ids.otherOrg]],
      ),
    );
    expect(rows[0]).toEqual({ orgs: 2, subs: 2, props: 0 });
    const usage = await asUser(staff, (c) =>
      c.query(`SELECT * FROM app_platform_usage($1)`, [ids.org]),
    );
    expect(usage.rows[0]).toMatchObject({ properties: 1, units: 0 });
    const outsider = await asUser(ids.manager, (c) =>
      c.query(`SELECT count(*)::int AS n FROM organisations WHERE id = $1`, [ids.otherOrg]),
    );
    expect(outsider.rows[0].n).toBe(0);
  });

  it('change plans and suspend only through the functions, audited, for admins only', async () => {
    await expect(
      asUser(ids.manager, (c) =>
        c.query(`SELECT app_platform_set_subscription($1, 'STARTER', 'ACTIVE', NULL, 'x')`, [
          ids.org,
        ]),
      ),
    ).rejects.toThrow(/platform administrators only/);
    await expect(
      asUser(staff, (c) =>
        c.query(`SELECT app_platform_set_subscription($1, 'STARTER', 'ACTIVE', NULL, '')`, [
          ids.org,
        ]),
      ),
    ).rejects.toThrow(/give a reason/);
    await asUser(staff, (c) =>
      c.query(
        `SELECT app_platform_set_subscription($1, 'PROFESSIONAL', 'ACTIVE', NULL, 'Signed contract')`,
        [ids.org],
      ),
    );
    await asUser(staff, (c) =>
      c.query(`SELECT app_platform_set_organisation_status($1, 'SUSPENDED', 'Unpaid')`, [ids.org]),
    );
    await expect(
      asUser(staff, (c) =>
        c.query(`SELECT app_platform_set_organisation_status($1, 'ARCHIVED', 'x')`, [ids.org]),
      ),
    ).rejects.toThrow(/only suspend and reactivate/);
    await asUser(staff, (c) =>
      c.query(`SELECT app_platform_set_organisation_status($1, 'ACTIVE', 'Paid')`, [ids.org]),
    );
    const { rows } = await asOrg((c) =>
      c.query(
        `SELECT action, actor_user_id = $1 AS by_staff FROM audit_logs
          WHERE action IN ('subscription.changed', 'organisation.suspended', 'organisation.reactivated')
          ORDER BY created_at`,
        [staff],
      ),
    );
    expect(rows).toEqual([
      { action: 'subscription.changed', by_staff: true },
      { action: 'organisation.suspended', by_staff: true },
      { action: 'organisation.reactivated', by_staff: true },
    ]);
    const events = await asOrg((c) =>
      c.query(`SELECT to_plan, reason FROM subscription_events ORDER BY created_at DESC LIMIT 1`),
    );
    expect(events.rows[0]).toEqual({ to_plan: 'PROFESSIONAL', reason: 'Signed contract' });
  });

  it('stop at revocation, and cannot be granted by the application', async () => {
    await expect(
      asUser(staff, (c) =>
        c.query(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [ids.manager]),
      ),
    ).rejects.toThrow(/permission denied/);
    await owner(`UPDATE platform_admins SET revoked_at = now() WHERE user_id = $1`, [staff]);
    const { rows } = await asUser(staff, (c) =>
      c.query(`SELECT count(*)::int AS n FROM organisations WHERE id = $1`, [ids.otherOrg]),
    );
    expect(rows[0].n).toBe(0);
  });
});

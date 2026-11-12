import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Subscriptions (migration 20261130090000_subscriptions): new organisations start a 30-day trial
 * of the full plan, logged; the application cannot change plans, subscriptions or their history;
 * plan limits on properties and units are enforced by the database; tenant-isolated.
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
    [ids.manager, `sub-${ids.manager}@example.test`],
  );
  for (const org of [ids.org, ids.otherOrg]) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `sb-${org.slice(0, 8)}`],
      ),
    );
  }
  await asOrg((c) =>
    c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Subscriptions', 'SB', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    ),
  );
});

afterAll(async () => {
  await app?.end();
});

/** Changes a subscription as the platform will (Part 2): as the owner, in the tenant's context. */
async function setPlan(org: string, plan: string, status = 'ACTIVE') {
  const client = new pg.Client({ connectionString: inject('superuserDatabaseUrl') });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [org]);
    await client.query("SELECT set_config('app.subscription_reason', 'test', true)");
    await client.query(
      `UPDATE subscriptions SET plan_code = $2, status = $3::"SubscriptionStatus",
              trial_ends_at = CASE WHEN $3::text = 'TRIAL' THEN now() + interval '1 day' END
        WHERE organisation_id = $1`,
      [org, plan, status],
    );
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

const unit = (number: string) =>
  asOrg((c) =>
    c.query(
      `INSERT INTO units (id, organisation_id, property_id, number, type, updated_at)
       VALUES ($1, $2, $3, $4, 'APARTMENT', now())`,
      [randomUUID(), ids.org, ids.prop, number],
    ),
  );

const property = (code: string) =>
  asOrg((c) =>
    c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, $3, $3, 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [randomUUID(), ids.org, code],
    ),
  );

describe('subscriptions', () => {
  it('start new organisations on a 30-day trial of the full plan, with a history entry', async () => {
    const { rows } = await asOrg((c) =>
      c.query(
        `SELECT s.plan_code, s.status, s.trial_ends_at > now() + interval '29 days' AS month,
                (SELECT count(*)::int FROM subscription_events e WHERE e.organisation_id = s.organisation_id) AS events
           FROM subscriptions s`,
      ),
    );
    expect(rows).toEqual([{ plan_code: 'ENTERPRISE', status: 'TRIAL', month: true, events: 1 }]);
    const plans = await asOrg((c) => c.query(`SELECT code FROM plans ORDER BY position`));
    expect(plans.rows.map((r) => r.code)).toEqual(['STARTER', 'PROFESSIONAL', 'ENTERPRISE']);
  });

  it('are read-only to the application, and their history is append-only', async () => {
    await expect(
      asOrg((c) => c.query(`UPDATE subscriptions SET plan_code = 'STARTER'`)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asOrg((c) =>
        c.query(`INSERT INTO plans (code, name, features) VALUES ('FREE', 'Free', '{}')`),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(asOrg((c) => c.query(`DELETE FROM subscription_events`))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('enforce the plan limits on properties and units', async () => {
    await setPlan(ids.org, 'STARTER');
    await expect(property('SECOND')).rejects.toThrow(/at most 1 properties/);
    await setPlan(ids.org, 'PROFESSIONAL');
    await property('SECOND');
    await unit('U1');
    const { rows } = await asOrg((c) =>
      c.query(`SELECT to_plan, from_plan, reason FROM subscription_events ORDER BY created_at`),
    );
    expect(rows.map((r) => r.to_plan)).toEqual(['ENTERPRISE', 'STARTER', 'PROFESSIONAL']);
    expect(rows[2]).toMatchObject({ from_plan: 'STARTER', reason: 'test' });
  });

  it('are invisible to another organisation', async () => {
    const { rows } = await inTenant(ids.otherOrg, (c) =>
      c.query(`SELECT organisation_id FROM subscriptions`),
    );
    expect(rows).toEqual([{ organisation_id: ids.otherOrg }]);
  });
});

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Announcements (migration 20261123090000_announcements): drafts are edited freely; publishing
 * records who and when and fixes the content; withdrawing needs a reason and is final; copies go
 * only to recipients of published announcements, who alone read and acknowledge them, once each;
 * app_property_resident_users() lists the people living at a property or building today.
 * Runs as veyra_app.
 */

let app: pg.Pool;

const ids = {
  org: randomUUID(),
  otherOrg: randomUUID(),
  prop: randomUUID(),
  towerA: randomUUID(),
  towerB: randomUUID(),
  unitA: randomUUID(),
  unitB: randomUUID(),
  manager: randomUUID(),
  ownerA: randomUUID(),
  tenantB: randomUUID(),
  formerTenant: randomUUID(),
};

async function inTenant<T>(
  org: string,
  work: (c: pg.PoolClient) => Promise<T>,
  user: string = ids.manager,
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
const asManager = <T>(work: (c: pg.PoolClient) => Promise<T>) => inTenant(ids.org, work);

async function draft(c: pg.PoolClient, ack = false) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO announcements (id, organisation_id, property_id, title, body, audience, requires_acknowledgement,
       created_by_user_id, updated_at)
     VALUES ($1, $2, $3, 'Water off on Friday', 'From 10:00 to 14:00.', 'RESIDENTS', $4, $5, now())`,
    [id, ids.org, ids.prop, ack, ids.manager],
  );
  return id;
}

const deliver = (c: pg.PoolClient, announcement: string, user: string) =>
  c.query(
    `INSERT INTO announcement_recipients (id, organisation_id, property_id, announcement_id, user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), ids.org, ids.prop, announcement, user],
  );

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 4 });
  for (const [id, name] of [
    [ids.manager, 'Manager'],
    [ids.ownerA, 'Owner A'],
    [ids.tenantB, 'Tenant B'],
    [ids.formerTenant, 'Former tenant'],
  ] as const) {
    await app.query(
      `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, $3, now())`,
      [id, `ann-${id}@example.test`, name],
    );
  }
  for (const org of [ids.org, ids.otherOrg]) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `an-${org.slice(0, 8)}`],
      ),
    );
  }
  await asManager(async (c) => {
    await c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'News', 'NW', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    );
    for (const [id, code] of [
      [ids.towerA, 'A'],
      [ids.towerB, 'B'],
    ] as const) {
      await c.query(
        `INSERT INTO buildings (id, organisation_id, property_id, name, code, updated_at) VALUES ($1, $2, $3, $4, $5, now())`,
        [id, ids.org, ids.prop, `Tower ${code}`, code],
      );
    }
    for (const [id, number, building] of [
      [ids.unitA, 'A1', ids.towerA],
      [ids.unitB, 'B1', ids.towerB],
    ] as const) {
      await c.query(
        `INSERT INTO units (id, organisation_id, property_id, building_id, number, type, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'APARTMENT', now())`,
        [id, ids.org, ids.prop, building, number],
      );
    }
    const person = async (user: string | null, name: string) => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO persons (id, organisation_id, full_name, user_id, updated_at) VALUES ($1, $2, $3, $4, now())`,
        [id, ids.org, name, user],
      );
      return id;
    };
    const owner = await person(ids.ownerA, 'Owner A');
    await c.query(
      `INSERT INTO ownerships (id, organisation_id, property_id, unit_id, person_id, share_numerator, share_denominator,
         effective_from, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, 1, '2026-01-01', now())`,
      [randomUUID(), ids.org, ids.prop, ids.unitA, owner],
    );
    for (const [user, start, end] of [
      [ids.tenantB, '2026-01-01', null],
      [ids.formerTenant, '2025-01-01', '2025-12-31'],
    ] as const) {
      const tenancy = randomUUID();
      await c.query(
        `INSERT INTO tenancies (id, organisation_id, property_id, unit_id, start_date, end_date, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())`,
        [tenancy, ids.org, ids.prop, ids.unitB, start, end],
      );
      await c.query(
        `INSERT INTO tenancy_occupants (id, organisation_id, tenancy_id, person_id, is_primary) VALUES ($1, $2, $3, $4, true)`,
        [randomUUID(), ids.org, tenancy, await person(user, 'Tenant')],
      );
    }
    // A resident without a login receives nothing in the app.
    const noLogin = await person(null, 'No login');
    await c.query(
      `INSERT INTO ownerships (id, organisation_id, property_id, unit_id, person_id, share_numerator, share_denominator,
         effective_from, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, 1, '2026-01-01', now())`,
      [randomUUID(), ids.org, ids.prop, ids.unitB, noLogin],
    );
  });
});

afterAll(async () => {
  await app?.end();
});

describe('audience', () => {
  it('lists the people living at the property or a building today, with a login', async () => {
    const users = (building: string | null) =>
      asManager(async (c) =>
        (
          await c.query(`SELECT user_id FROM app_property_resident_users($1, $2)`, [
            ids.prop,
            building,
          ])
        ).rows
          .map((r) => r.user_id)
          .sort(),
      );
    expect(await users(null)).toEqual([ids.ownerA, ids.tenantB].sort());
    expect(await users(ids.towerB)).toEqual([ids.tenantB]);
  });
});

describe('announcements', () => {
  it('are edited as drafts, fixed once published, and withdrawn with a reason for good', async () => {
    const id = await asManager((c) => draft(c));
    await asManager((c) =>
      c.query(`UPDATE announcements SET title = 'Water off on Saturday' WHERE id = $1`, [id]),
    );
    await expect(asManager((c) => deliver(c, id, ids.ownerA))).rejects.toThrow(
      /only a published announcement/,
    );
    await expect(
      asManager((c) =>
        c.query(`UPDATE announcements SET audience = 'BUILDING_RESIDENTS' WHERE id = $1`, [id]),
      ),
    ).rejects.toThrow(/announcements_building/);
    await asManager((c) =>
      c.query(`UPDATE announcements SET status = 'PUBLISHED' WHERE id = $1`, [id]),
    );
    await asManager(async (c) => {
      const { rows } = await c.query(
        `SELECT published_by_user_id, published_at FROM announcements WHERE id = $1`,
        [id],
      );
      expect(rows[0].published_by_user_id).toBe(ids.manager);
      expect(rows[0].published_at).not.toBeNull();
    });
    await expect(
      asManager((c) => c.query(`UPDATE announcements SET body = 'Changed' WHERE id = $1`, [id])),
    ).rejects.toThrow(/never changes/);
    await expect(
      asManager((c) =>
        c.query(`UPDATE announcements SET status = 'WITHDRAWN' WHERE id = $1`, [id]),
      ),
    ).rejects.toThrow(/why the announcement is withdrawn/);
    await asManager((c) =>
      c.query(
        `UPDATE announcements SET status = 'WITHDRAWN', withdraw_reason = 'Repair postponed' WHERE id = $1`,
        [id],
      ),
    );
    await expect(
      asManager((c) =>
        c.query(`UPDATE announcements SET status = 'PUBLISHED' WHERE id = $1`, [id]),
      ),
    ).rejects.toThrow(/withdrawn and no longer changes/);
  });

  it('are read and acknowledged only by their recipient, once', async () => {
    const plain = await asManager((c) => draft(c));
    const ack = await asManager((c) => draft(c, true));
    for (const id of [plain, ack]) {
      await asManager(async (c) => {
        await c.query(`UPDATE announcements SET status = 'PUBLISHED' WHERE id = $1`, [id]);
        await deliver(c, id, ids.ownerA);
      });
    }
    const touch = (id: string, column: 'read_at' | 'acknowledged_at', user: string) =>
      inTenant(
        ids.org,
        (c) =>
          c.query(
            `UPDATE announcement_recipients SET ${column} = now() WHERE announcement_id = $1`,
            [id],
          ),
        user,
      );
    await expect(touch(plain, 'read_at', ids.manager)).rejects.toThrow(/only the recipient/);
    await expect(touch(plain, 'acknowledged_at', ids.ownerA)).rejects.toThrow(
      /does not ask for acknowledgement/,
    );
    await touch(ack, 'acknowledged_at', ids.ownerA);
    const first = await asManager(
      async (c) =>
        (
          await c.query(
            `SELECT read_at, acknowledged_at FROM announcement_recipients WHERE announcement_id = $1`,
            [ack],
          )
        ).rows[0],
    );
    expect(first.read_at).not.toBeNull();
    expect(first.acknowledged_at).not.toBeNull();
    await touch(ack, 'acknowledged_at', ids.ownerA);
    const second = await asManager(
      async (c) =>
        (
          await c.query(
            `SELECT acknowledged_at FROM announcement_recipients WHERE announcement_id = $1`,
            [ack],
          )
        ).rows[0],
    );
    expect(second.acknowledged_at).toEqual(first.acknowledged_at);
    await expect(deliverTwice(ack)).rejects.toThrow(
      /announcement_recipients_announcement_id_user_id_key/,
    );
  });
});

const deliverTwice = (id: string) => asManager((c) => deliver(c, id, ids.ownerA));

describe('isolation', () => {
  it('shows another organisation nothing and refuses deletes', async () => {
    const { rows } = await inTenant(ids.otherOrg, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM announcements)::int AS a, (SELECT count(*) FROM announcement_recipients)::int AS r`,
      ),
    );
    expect(rows[0]).toEqual({ a: 0, r: 0 });
    await expect(asManager((c) => c.query(`DELETE FROM announcements`))).rejects.toThrow(
      /permission denied/,
    );
  });
});

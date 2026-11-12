import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Assets and preventive maintenance (migration 20261120090000_assets): assets have a tag unique
 * per property and exactly one active place, start in use, need a note when out of service and
 * are retired for good only once nothing is scheduled or open; schedules live only on assets in
 * use; work on an asset is where the asset is; a schedule raises at most one work order per due
 * date; links never change; everything is tenant-isolated. Runs as veyra_app.
 */

let app: pg.Pool;

const ids = {
  org: randomUUID(),
  otherOrg: randomUUID(),
  prop: randomUUID(),
  unit: randomUUID(),
  plant: randomUUID(),
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

async function asset(c: pg.PoolClient, tag: string, place: { unit?: string; area?: string } = {}) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO assets (id, organisation_id, property_id, tag, name, category, unit_id, common_area_id, updated_at)
     VALUES ($1, $2, $3, $4, 'Booster pump', 'PLUMBING', $5, $6, now())`,
    [id, ids.org, ids.prop, tag, place.unit ?? null, place.area ?? (place.unit ? null : ids.plant)],
  );
  return id;
}

async function schedule(c: pg.PoolClient, assetId: string) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO maintenance_schedules (id, organisation_id, property_id, asset_id, title, interval_unit,
       interval_count, next_due_on, created_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, 'Quarterly service', 'MONTH', 3, '2026-12-01', $5, now())`,
    [id, ids.org, ids.prop, assetId, ids.manager],
  );
  return id;
}

async function scheduledWork(
  c: pg.PoolClient,
  input: {
    asset: string;
    schedule?: string | null;
    date?: string | null;
    unit?: string | null;
    area?: string | null;
  },
) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO work_orders (id, organisation_id, property_id, unit_id, common_area_id, category, priority, title,
       asset_id, schedule_id, scheduled_for, created_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'PLUMBING', 'MEDIUM', 'Service the pump', $6, $7, $8, $9, now())`,
    [
      id,
      ids.org,
      ids.prop,
      input.unit ?? null,
      input.area === undefined ? (input.unit ? null : ids.plant) : input.area,
      input.asset,
      input.schedule ?? null,
      input.date ?? null,
      ids.manager,
    ],
  );
  return id;
}

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 4 });
  await app.query(
    `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, 'Manager', now())`,
    [ids.manager, `asset-${ids.manager}@example.test`],
  );
  for (const org of [ids.org, ids.otherOrg]) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `as-${org.slice(0, 8)}`],
      ),
    );
  }
  await asOrg(async (c) => {
    await c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Assets', 'AS', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    );
    await c.query(
      `INSERT INTO units (id, organisation_id, property_id, number, type, updated_at)
       VALUES ($1, $2, $3, 'A1', 'APARTMENT', now())`,
      [ids.unit, ids.org, ids.prop],
    );
    await c.query(
      `INSERT INTO common_areas (id, organisation_id, property_id, name, type, updated_at)
       VALUES ($1, $2, $3, 'Plant room', 'OTHER', now())`,
      [ids.plant, ids.org, ids.prop],
    );
  });
});

afterAll(async () => {
  await app?.end();
});

describe('assets', () => {
  it('have a unique tag, one place, and start in use', async () => {
    await asOrg((c) => asset(c, 'PUMP-01'));
    await expect(asOrg((c) => asset(c, 'PUMP-01'))).rejects.toThrow(/assets_property_id_tag_key/);
    await expect(asOrg((c) => asset(c, 'pump-02'))).rejects.toThrow(/assets_text/);
    await expect(
      asOrg((c) =>
        c.query(
          `INSERT INTO assets (id, organisation_id, property_id, tag, name, category, unit_id, common_area_id, updated_at)
           VALUES ($1, $2, $3, 'TWO', 'Two places', 'OTHER', $4, $5, now())`,
          [randomUUID(), ids.org, ids.prop, ids.unit, ids.plant],
        ),
      ),
    ).rejects.toThrow(/assets_one_location/);
    await expect(
      asOrg((c) =>
        c.query(
          `INSERT INTO assets (id, organisation_id, property_id, tag, name, category, common_area_id, status, status_note, updated_at)
           VALUES ($1, $2, $3, 'BROKEN', 'Broken', 'OTHER', $4, 'OUT_OF_SERVICE', 'x', now())`,
          [randomUUID(), ids.org, ids.prop, ids.plant],
        ),
      ),
    ).rejects.toThrow(/start in use/);
  });

  it('need a note out of service and retire for good only when nothing is scheduled or open', async () => {
    const id = await asOrg((c) => asset(c, 'GEN-01'));
    await expect(
      asOrg((c) => c.query(`UPDATE assets SET status = 'OUT_OF_SERVICE' WHERE id = $1`, [id])),
    ).rejects.toThrow(/assets_status/);
    await asOrg((c) =>
      c.query(
        `UPDATE assets SET status = 'OUT_OF_SERVICE', status_note = 'Alternator failed' WHERE id = $1`,
        [id],
      ),
    );
    const s = await asOrg((c) => schedule(c, id));
    const retire = () =>
      asOrg((c) =>
        c.query(`UPDATE assets SET status = 'RETIRED', status_note = 'Replaced' WHERE id = $1`, [
          id,
        ]),
      );
    await expect(retire()).rejects.toThrow(/pause the schedules/);
    await asOrg((c) =>
      c.query(`UPDATE maintenance_schedules SET active = false WHERE id = $1`, [s]),
    );
    const w = await asOrg((c) => scheduledWork(c, { asset: id }));
    await expect(retire()).rejects.toThrow(/open work on this asset/);
    await asOrg((c) =>
      c.query(
        `UPDATE work_orders SET status = 'CANCELLED', status_note = 'Not needed' WHERE id = $1`,
        [w],
      ),
    );
    await retire();
    await expect(
      asOrg((c) => c.query(`UPDATE assets SET name = 'Renamed' WHERE id = $1`, [id])),
    ).rejects.toThrow(/retired and no longer changes/);
    await expect(
      asOrg((c) => c.query(`UPDATE maintenance_schedules SET active = true WHERE id = $1`, [s])),
    ).rejects.toThrow(/asset is retired/);
  });
});

describe('preventive work', () => {
  it('is where the asset is, once per due date, and keeps its links', async () => {
    const id = await asOrg((c) => asset(c, 'LIFT-01'));
    const s = await asOrg((c) => schedule(c, id));
    await expect(
      asOrg((c) => scheduledWork(c, { asset: id, unit: ids.unit, area: null })),
    ).rejects.toThrow(/where the asset is/);
    await expect(
      asOrg((c) => scheduledWork(c, { asset: id, schedule: s, date: null })),
    ).rejects.toThrow(/work_orders_schedule/);
    const w = await asOrg((c) => scheduledWork(c, { asset: id, schedule: s, date: '2026-12-01' }));
    await expect(
      asOrg((c) => scheduledWork(c, { asset: id, schedule: s, date: '2026-12-01' })),
    ).rejects.toThrow(/work_orders_schedule_id_scheduled_for_key/);
    await expect(
      asOrg((c) => c.query(`UPDATE work_orders SET asset_id = NULL WHERE id = $1`, [w])),
    ).rejects.toThrow(/keeps its asset/);
    // Another asset's schedule cannot raise work on this one.
    const other = await asOrg((c) => asset(c, 'LIFT-02'));
    await expect(
      asOrg((c) => scheduledWork(c, { asset: other, schedule: s, date: '2027-03-01' })),
    ).rejects.toThrow(/schedule's asset/);
  });
});

describe('isolation', () => {
  it('shows another organisation nothing', async () => {
    const { rows } = await inTenant(ids.otherOrg, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM assets)::int AS a, (SELECT count(*) FROM maintenance_schedules)::int AS s`,
      ),
    );
    expect(rows[0]).toEqual({ a: 0, s: 0 });
    await expect(asOrg((c) => c.query(`DELETE FROM assets`))).rejects.toThrow(/permission denied/);
  });
});

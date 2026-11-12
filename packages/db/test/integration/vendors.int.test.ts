import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Vendors (migration 20261119090000_vendors): vendors start active, their names are unique
 * (ignoring case) among those not archived, suspending needs a reason and archiving is final and
 * refused while they have open work; compliance documents are never edited, only voided once;
 * work orders may go to an active vendor instead of a technician, each change logged by the
 * database; everything is tenant-isolated. Runs as veyra_app unless stated.
 */

let app: pg.Pool;
let superuser: pg.Pool;

const ids = {
  org: randomUUID(),
  otherOrg: randomUUID(),
  prop: randomUUID(),
  unit: randomUUID(),
  manager: randomUUID(),
};

async function inTenant<T>(
  organisationId: string,
  work: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [organisationId]);
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

async function vendor(c: pg.PoolClient, name: string, extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  const cols = ['id', 'organisation_id', 'name', 'categories', 'updated_at', ...Object.keys(extra)];
  const values = [id, ids.org, name, '{PLUMBING}', new Date(), ...Object.values(extra)];
  await c.query(
    `INSERT INTO vendors (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    values,
  );
  return id;
}

async function workOrder(
  c: pg.PoolClient,
  input: { vendor?: string | null; tech?: string | null },
) {
  const id = randomUUID();
  const assigned = input.vendor || input.tech;
  await c.query(
    `INSERT INTO work_orders (id, organisation_id, property_id, unit_id, category, priority, title, status,
       assigned_to_user_id, vendor_id, created_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, 'PLUMBING', 'MEDIUM', 'Replace the pump', $5, $6, $7, $8, now())`,
    [
      id,
      ids.org,
      ids.prop,
      ids.unit,
      assigned ? 'ASSIGNED' : 'OPEN',
      input.tech ?? null,
      input.vendor ?? null,
      ids.manager,
    ],
  );
  return id;
}

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 4 });
  superuser = new pg.Pool({ connectionString: inject('superuserDatabaseUrl'), max: 1 });
  await app.query(
    `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, 'Manager', now())`,
    [ids.manager, `vendor-${ids.manager}@example.test`],
  );
  for (const org of [ids.org, ids.otherOrg]) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `vd-${org.slice(0, 8)}`],
      ),
    );
  }
  await asOrg(async (c) => {
    await c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Vendors', 'VD', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    );
    await c.query(
      `INSERT INTO units (id, organisation_id, property_id, number, type, updated_at)
       VALUES ($1, $2, $3, 'V1', 'APARTMENT', now())`,
      [ids.unit, ids.org, ids.prop],
    );
  });
});

afterAll(async () => {
  await app?.end();
  await superuser?.end();
});

describe('vendors', () => {
  it('start active with trimmed details and a name unique among live vendors', async () => {
    const id = await asOrg((c) => vendor(c, 'AquaFix Plumbing', { email: 'ops@aquafix.example' }));
    await expect(asOrg((c) => vendor(c, 'aquafix plumbing'))).rejects.toThrow(
      /vendors_live_name_key/,
    );
    await expect(asOrg((c) => vendor(c, ' Spaced '))).rejects.toThrow(/vendors_text/);
    await expect(asOrg((c) => vendor(c, 'Shouty', { email: 'OPS@X.EXAMPLE' }))).rejects.toThrow(
      /vendors_text/,
    );
    await expect(asOrg((c) => vendor(c, 'Late', { status: 'SUSPENDED' }))).rejects.toThrow(
      /start active/,
    );
    // Archived, the name is free again; archiving is final.
    await asOrg((c) => c.query(`UPDATE vendors SET status = 'ARCHIVED' WHERE id = $1`, [id]));
    await asOrg((c) => vendor(c, 'AquaFix Plumbing'));
    await expect(
      asOrg((c) => c.query(`UPDATE vendors SET status = 'ACTIVE' WHERE id = $1`, [id])),
    ).rejects.toThrow(/archived and no longer changes/);
  });

  it('are suspended with a reason, which clears when reactivated', async () => {
    const id = await asOrg((c) => vendor(c, 'Spark Electric'));
    await expect(
      asOrg((c) => c.query(`UPDATE vendors SET status = 'SUSPENDED' WHERE id = $1`, [id])),
    ).rejects.toThrow(/vendors_status/);
    await asOrg((c) =>
      c.query(
        `UPDATE vendors SET status = 'SUSPENDED', status_note = 'Insurance lapsed' WHERE id = $1`,
        [id],
      ),
    );
    await asOrg(async (c) => {
      await c.query(`UPDATE vendors SET status = 'ACTIVE', status_note = 'kept' WHERE id = $1`, [
        id,
      ]);
      const { rows } = await c.query(`SELECT status_note FROM vendors WHERE id = $1`, [id]);
      expect(rows[0].status_note).toBeNull();
    });
  });
});

describe('documents', () => {
  it('are never edited, only voided once, and not added to archived vendors', async () => {
    const v = await asOrg((c) => vendor(c, 'Cool Air HVAC'));
    const doc = randomUUID();
    const add = (id: string, from: string | null, to: string | null) =>
      asOrg((c) =>
        c.query(
          `INSERT INTO vendor_documents (id, organisation_id, vendor_id, kind, title, valid_from, expires_on,
             created_by_user_id)
           VALUES ($1, $2, $3, 'INSURANCE', 'Public liability', $4, $5, $6)`,
          [id, ids.org, v, from, to, ids.manager],
        ),
      );
    await expect(add(randomUUID(), '2026-06-01', '2026-01-01')).rejects.toThrow(
      /vendor_documents_dates/,
    );
    await add(doc, '2026-01-01', '2026-12-31');
    await expect(
      asOrg((c) => c.query(`UPDATE vendor_documents SET title = 'Other' WHERE id = $1`, [doc])),
    ).rejects.toThrow(/never edited/);
    await asOrg((c) =>
      c.query(
        `UPDATE vendor_documents SET voided_at = now(), voided_by_user_id = $2, void_reason = 'Wrong year'
          WHERE id = $1`,
        [doc, ids.manager],
      ),
    );
    await expect(
      asOrg((c) =>
        c.query(`UPDATE vendor_documents SET void_reason = 'Again' WHERE id = $1`, [doc]),
      ),
    ).rejects.toThrow(/never edited/);
    await asOrg((c) => c.query(`UPDATE vendors SET status = 'ARCHIVED' WHERE id = $1`, [v]));
    await expect(add(randomUUID(), null, null)).rejects.toThrow(/vendor is archived/);
  });
});

describe('work orders', () => {
  it('go to an active vendor instead of a technician, logged by the database', async () => {
    const v = await asOrg((c) => vendor(c, 'Lift Masters'));
    const w = await asOrg((c) => workOrder(c, { vendor: v }));
    await asOrg(async (c) => {
      const { rows } = await c.query(
        `SELECT type, to_value, actor_user_id FROM maintenance_events WHERE work_order_id = $1 ORDER BY sequence`,
        [w],
      );
      expect(rows.map((r) => [r.type, r.to_value])).toEqual([
        ['STATUS_CHANGED', 'ASSIGNED'],
        ['VENDOR_CHANGED', v],
      ]);
      expect(rows[1].actor_user_id).toBe(ids.manager);
    });
    // Open work has nobody on it; assigning moves it to assigned.
    await expect(
      asOrg(async (c) => {
        const open = await workOrder(c, {});
        await c.query(`UPDATE work_orders SET vendor_id = $2 WHERE id = $1`, [open, v]);
      }),
    ).rejects.toThrow(/moves it to assigned/);
    // Archiving waits for the vendor's open work.
    await expect(
      asOrg((c) => c.query(`UPDATE vendors SET status = 'ARCHIVED' WHERE id = $1`, [v])),
    ).rejects.toThrow(/open work of this vendor/);
    await asOrg((c) =>
      c.query(
        `UPDATE work_orders SET status = 'CANCELLED', status_note = 'Not needed' WHERE id = $1`,
        [w],
      ),
    );
    await asOrg((c) => c.query(`UPDATE vendors SET status = 'ARCHIVED' WHERE id = $1`, [v]));
  });

  it('never go to a suspended or archived vendor', async () => {
    const v = await asOrg((c) => vendor(c, 'Paused Painters'));
    await asOrg((c) =>
      c.query(`UPDATE vendors SET status = 'SUSPENDED', status_note = 'Complaints' WHERE id = $1`, [
        v,
      ]),
    );
    await expect(asOrg((c) => workOrder(c, { vendor: v }))).rejects.toThrow(/active vendor/);
  });
});

describe('isolation', () => {
  it('shows another organisation nothing and refuses its writes', async () => {
    const counts = await inTenant(ids.otherOrg, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM vendors)::int AS v, (SELECT count(*) FROM vendor_documents)::int AS d`,
      ),
    );
    expect(counts.rows[0]).toEqual({ v: 0, d: 0 });
    await expect(
      inTenant(ids.otherOrg, (c) =>
        c.query(
          `INSERT INTO vendors (id, organisation_id, name, categories, updated_at) VALUES ($1, $2, 'X', '{}', now())`,
          [randomUUID(), ids.org],
        ),
      ),
    ).rejects.toThrow();
    await expect(inTenant(ids.org, (c) => c.query(`DELETE FROM vendors`))).rejects.toThrow(
      /permission denied/,
    );
  });
});

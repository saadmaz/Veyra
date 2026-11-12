import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Approvals (migration 20261128090000_approvals): requests numbered per property, in its
 * currency, never changed; settled only by decisions (approved at the required number, rejected
 * at the first rejection with a reason), never decided by the requester, once per person, only by
 * the person recorded; withdrawn only by the requester; one active policy per threshold;
 * tenant-isolated.
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
    [ids.manager, `apr-${ids.manager}@example.test`],
  );
  for (const org of [ids.org, ids.otherOrg]) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `ap-${org.slice(0, 8)}`],
      ),
    );
  }
  await asOrg((c) =>
    c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Approvals', 'AP', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    ),
  );
});

afterAll(async () => {
  await app?.end();
});

async function user() {
  const id = randomUUID();
  await app.query(
    `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, 'Approver', now())`,
    [id, `apr-${id}@example.test`],
  );
  return id;
}

async function as<T>(userId: string, work: (c: pg.PoolClient) => Promise<T>) {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [ids.org]);
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

async function request(
  over: { required?: number; currency?: string | null; amount?: number | null } = {},
) {
  const id = randomUUID();
  const { rows } = await asOrg((c) =>
    c.query(
      `INSERT INTO approval_requests (id, organisation_id, property_id, request_type, title, description, amount_minor,
         currency, required_approvals, approvers, requested_by_user_id, updated_at)
       VALUES ($1, $2, $3, 'EXPENSE', 'New pump', 'The old pump failed.', $4, $5, $6, 'MANAGERS', $7, now())
       RETURNING request_number`,
      [
        id,
        ids.org,
        ids.prop,
        over.amount === undefined ? 150000 : over.amount,
        over.currency === undefined ? 'PKR' : over.currency,
        over.required ?? 2,
        ids.manager,
      ],
    ),
  );
  return { id, number: Number(rows[0].request_number) };
}

const decide = (
  requestId: string,
  userId: string,
  decision: 'APPROVE' | 'REJECT',
  note: string | null = null,
) =>
  as(userId, (c) =>
    c.query(
      `INSERT INTO approval_decisions (id, organisation_id, property_id, request_id, user_id, decision, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), ids.org, ids.prop, requestId, userId, decision, note],
    ),
  );

const status = async (id: string) =>
  (
    await asOrg((c) =>
      c.query(`SELECT status, decided_at FROM approval_requests WHERE id = $1`, [id]),
    )
  ).rows[0];

describe('approvals', () => {
  it('number requests per property, in the property currency, and never change them', async () => {
    const a = await request();
    const b = await request();
    expect(b.number).toBe(a.number + 1);
    await expect(request({ currency: 'USD' })).rejects.toThrow(/property's currency/);
    await expect(request({ currency: null })).rejects.toThrow(/approval_requests_shape/);
    await request({ amount: null, currency: null });
    await expect(
      asOrg((c) => c.query(`UPDATE approval_requests SET title = 'Other' WHERE id = $1`, [a.id])),
    ).rejects.toThrow(/never changes/);
    await expect(
      asOrg((c) =>
        c.query(`UPDATE approval_requests SET status = 'APPROVED' WHERE id = $1`, [a.id]),
      ),
    ).rejects.toThrow(/settled by their decisions/);
  });

  it('settle at the required approvals, never by the requester, once per person', async () => {
    const r = await request({ required: 2 });
    const [x, y] = [await user(), await user()];
    await expect(decide(r.id, ids.manager, 'APPROVE')).rejects.toThrow(/own request/);
    await expect(
      as(x, (c) =>
        c.query(
          `INSERT INTO approval_decisions (id, organisation_id, property_id, request_id, user_id, decision)
         VALUES ($1, $2, $3, $4, $5, 'APPROVE')`,
          [randomUUID(), ids.org, ids.prop, r.id, y],
        ),
      ),
    ).rejects.toThrow(/only their own decisions/);
    await decide(r.id, x, 'APPROVE');
    expect((await status(r.id)).status).toBe('PENDING');
    await expect(decide(r.id, x, 'APPROVE')).rejects.toThrow(
      /approval_decisions_request_id_user_id_key/,
    );
    await decide(r.id, y, 'APPROVE');
    const settled = await status(r.id);
    expect(settled.status).toBe('APPROVED');
    expect(settled.decided_at).not.toBeNull();
    await expect(decide(r.id, await user(), 'REJECT', 'Too late')).rejects.toThrow(/settled/);
  });

  it('reject at the first rejection, with a reason; only the requester withdraws', async () => {
    const r = await request({ required: 3 });
    const x = await user();
    await expect(decide(r.id, x, 'REJECT')).rejects.toThrow(/approval_decisions_note/);
    await decide(r.id, x, 'REJECT', 'Get a second quote');
    expect((await status(r.id)).status).toBe('REJECTED');
    const w = await request();
    await expect(
      as(x, (c) =>
        c.query(`UPDATE approval_requests SET status = 'WITHDRAWN' WHERE id = $1`, [w.id]),
      ),
    ).rejects.toThrow(/only the requester/);
    await asOrg((c) =>
      c.query(`UPDATE approval_requests SET status = 'WITHDRAWN' WHERE id = $1`, [w.id]),
    );
    await expect(decide(w.id, x, 'APPROVE')).rejects.toThrow(/settled/);
  });

  it('keep one active policy per threshold, committees only for committee approval', async () => {
    const policy = (min: number, approvers = 'MANAGERS', committee: string | null = null) =>
      asOrg((c) =>
        c.query(
          `INSERT INTO approval_policies (id, organisation_id, property_id, request_type, min_amount_minor, required_approvals,
             approvers, committee_id, updated_at)
           VALUES ($1, $2, $3, 'PURCHASE', $4, 2, $5, $6, now())`,
          [randomUUID(), ids.org, ids.prop, min, approvers, committee],
        ),
      );
    await policy(0);
    await expect(policy(0)).rejects.toThrow(/approval_policies_active_threshold/);
    await expect(policy(100000, 'COMMITTEE')).rejects.toThrow(/approval_policies_shape/);
    const board = randomUUID();
    await asOrg((c) =>
      c.query(
        `INSERT INTO committees (id, organisation_id, property_id, name, updated_at) VALUES ($1, $2, $3, 'Board', now())`,
        [board, ids.org, ids.prop],
      ),
    );
    await policy(100000, 'COMMITTEE', board);
    await asOrg((c) =>
      c.query(`UPDATE committees SET status = 'DISSOLVED' WHERE id = $1`, [board]),
    );
    await expect(policy(500000, 'COMMITTEE', board)).rejects.toThrow(/dissolved/);
  });

  it('never change decisions, and are invisible to another organisation', async () => {
    await expect(asOrg((c) => c.query(`UPDATE approval_decisions SET note = 'x'`))).rejects.toThrow(
      /permission denied/,
    );
    const { rows } = await inTenant(ids.otherOrg, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM approval_requests)::int AS r, (SELECT count(*) FROM approval_decisions)::int AS d,
                (SELECT count(*) FROM approval_policies)::int AS p`,
      ),
    );
    expect(rows[0]).toEqual({ r: 0, d: 0, p: 0 });
    await expect(asOrg((c) => c.query(`DELETE FROM approval_requests`))).rejects.toThrow(
      /permission denied/,
    );
  });
});

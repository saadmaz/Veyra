import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Walk-in requests (migration 20261111150000_walk_in_requests): decided once and before expiry,
 * and the admission backstop: nobody without a pass is admitted to a unit unless a resident
 * approved, the approval is recent, and it is used once. Runs as veyra_app.
 */

let app: pg.Pool;

async function inTenant<T>(
  organisationId: string,
  work: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [organisationId]);
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

const ids = {
  org: randomUUID(),
  prop: randomUUID(),
  unit1: randomUUID(),
  unit2: randomUUID(),
  guard: randomUUID(),
  resident: randomUUID(),
};

interface RequestInput {
  unit?: string;
  createdMinutesAgo?: number;
  expiresInMinutes?: number;
  status?: 'PENDING' | 'APPROVED';
  decidedMinutesAgo?: number;
}

/** Inserts a request; times are relative to the database clock. */
const request = (c: pg.PoolClient, input: RequestInput = {}) => {
  const id = randomUUID();
  const created = input.createdMinutesAgo ?? 0;
  const approved = input.status === 'APPROVED';
  return c
    .query(
      `INSERT INTO walk_in_requests (id, organisation_id, property_id, unit_id, category, visitor_name,
         requested_by_user_id, status, expires_at, decided_at, decided_by_user_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'GUEST', 'Wally Walkin', $5, $6,
               now() - make_interval(mins => $7) + make_interval(mins => $8),
               CASE WHEN $9::boolean THEN now() - make_interval(mins => $10) END,
               CASE WHEN $9::boolean THEN $11::uuid END,
               now() - make_interval(mins => $7), now())`,
      [
        id,
        ids.org,
        ids.prop,
        input.unit ?? ids.unit1,
        ids.guard,
        input.status ?? 'PENDING',
        created,
        input.expiresInMinutes ?? 10,
        approved,
        input.decidedMinutesAgo ?? 0,
        ids.resident,
      ],
    )
    .then(() => id);
};

const decide = (c: pg.PoolClient, id: string, status: 'APPROVED' | 'DENIED' | 'CANCELLED') =>
  c.query(
    `UPDATE walk_in_requests SET status = $2, decided_at = now(), decided_by_user_id = $3 WHERE id = $1`,
    [id, status, ids.resident],
  );

const admit = (
  c: pg.PoolClient,
  input: { unit?: string | null; requestId?: string | null; invitationId?: string | null } = {},
) =>
  c.query(
    `INSERT INTO visits (id, organisation_id, property_id, unit_id, invitation_id, walk_in_request_id,
       category, visitor_name, decision, arrived_at, recorded_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'GUEST', 'Wally Walkin', 'ADMITTED', now(), $7, now())`,
    [
      randomUUID(),
      ids.org,
      ids.prop,
      input.unit === undefined ? ids.unit1 : input.unit,
      input.invitationId ?? null,
      input.requestId ?? null,
      ids.guard,
    ],
  );

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 3 });
  for (const id of [ids.guard, ids.resident]) {
    await app.query(
      `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, 'Walk-in Tester', now())`,
      [id, `walkin-${id}@example.test`],
    );
  }
  await inTenant(ids.org, async (c) => {
    await c.query(
      `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
       VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
      [ids.org, `walkin-${ids.org.slice(0, 8)}`],
    );
    await c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Gatehouse', 'WK', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    );
    for (const [unit, number] of [
      [ids.unit1, 'W1'],
      [ids.unit2, 'W2'],
    ]) {
      await c.query(
        `INSERT INTO units (id, organisation_id, property_id, number, type, updated_at)
         VALUES ($1, $2, $3, $4, 'APARTMENT', now())`,
        [unit, ids.org, ids.prop, number],
      );
    }
  });
});

afterAll(async () => {
  await app?.end();
});

describe('walk-in requests', () => {
  it('are invisible without tenant context', async () => {
    await inTenant(ids.org, (c) => request(c));
    const { rows } = await app.query('SELECT count(*)::int AS n FROM walk_in_requests');
    expect(rows[0].n).toBe(0);
  });

  it('expire within 30 minutes and record who decided', async () => {
    await expect(
      inTenant(ids.org, (c) => request(c, { expiresInMinutes: 31 })),
    ).rejects.toMatchObject({ code: '23514' });
    const id = await inTenant(ids.org, (c) => request(c));
    await expect(
      inTenant(ids.org, (c) =>
        c.query(
          `UPDATE walk_in_requests SET status = 'APPROVED', decided_at = now() WHERE id = $1`,
          [id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('are decided once and never edited', async () => {
    const id = await inTenant(ids.org, (c) => request(c));
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`UPDATE walk_in_requests SET visitor_name = 'Someone Else' WHERE id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await inTenant(ids.org, (c) => decide(c, id, 'DENIED'));
    await expect(inTenant(ids.org, (c) => decide(c, id, 'APPROVED'))).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('cannot be approved after they expire, but can still be cancelled', async () => {
    const late = await inTenant(ids.org, (c) =>
      request(c, { createdMinutesAgo: 20, expiresInMinutes: 10 }),
    );
    await expect(inTenant(ids.org, (c) => decide(c, late, 'APPROVED'))).rejects.toMatchObject({
      code: '23514',
    });
    await inTenant(ids.org, (c) => decide(c, late, 'CANCELLED'));
  });
});

describe('admitting a walk-in to a unit', () => {
  it('needs an approved request', async () => {
    await expect(inTenant(ids.org, (c) => admit(c))).rejects.toMatchObject({ code: '23514' });
    const pending = await inTenant(ids.org, (c) => request(c));
    await expect(inTenant(ids.org, (c) => admit(c, { requestId: pending }))).rejects.toMatchObject({
      code: '23514',
    });
    await inTenant(ids.org, (c) => decide(c, pending, 'APPROVED'));
    await inTenant(ids.org, (c) => admit(c, { requestId: pending }));
  });

  it('uses an approval once, for its own unit, within 15 minutes', async () => {
    const approved = await inTenant(ids.org, (c) => request(c, { status: 'APPROVED' }));
    await expect(
      inTenant(ids.org, (c) => admit(c, { unit: ids.unit2, requestId: approved })),
    ).rejects.toMatchObject({ code: '23503' });
    await inTenant(ids.org, (c) => admit(c, { requestId: approved }));
    await expect(inTenant(ids.org, (c) => admit(c, { requestId: approved }))).rejects.toMatchObject(
      { code: '23505' },
    );

    const lapsed = await inTenant(ids.org, (c) =>
      request(c, {
        status: 'APPROVED',
        createdMinutesAgo: 25,
        expiresInMinutes: 10,
        decidedMinutesAgo: 20,
      }),
    );
    await expect(inTenant(ids.org, (c) => admit(c, { requestId: lapsed }))).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('still admits walk-ins to the property itself without a request', async () => {
    await inTenant(ids.org, (c) => admit(c, { unit: null }));
  });
});

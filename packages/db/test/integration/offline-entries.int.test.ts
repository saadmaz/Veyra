import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Offline and paper entries (migration 20261111180000_offline_gate): idempotent sync by
 * client_ref, flags only on entries recorded after the fact, a supervisor's review once, and a
 * visit otherwise unchangeable. Runs as veyra_app.
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
  guard: randomUUID(),
  supervisor: randomUUID(),
};

interface Entry {
  source?: 'ONLINE' | 'PAPER' | 'OFFLINE_SYNC';
  clientRef?: string | null;
  reviewReason?: string | null;
  hoursAgo?: number;
}

const record = (c: pg.PoolClient, entry: Entry = {}) => {
  const id = randomUUID();
  return c
    .query(
      `INSERT INTO visits (id, organisation_id, property_id, category, visitor_name, decision,
         arrived_at, recorded_by_user_id, source, client_ref, review_reason, updated_at)
       VALUES ($1, $2, $3, 'DELIVERY', 'Olly Offline', 'ADMITTED',
               now() - make_interval(hours => $4), $5, $6, $7, $8, now())`,
      [
        id,
        ids.org,
        ids.prop,
        entry.hoursAgo ?? 2,
        ids.guard,
        entry.source ?? 'OFFLINE_SYNC',
        entry.clientRef === undefined ? randomUUID() : entry.clientRef,
        entry.reviewReason ?? null,
      ],
    )
    .then(() => id);
};

const review = (c: pg.PoolClient, id: string, note: string | null = 'Checked with the resident') =>
  c.query(
    'UPDATE visits SET reviewed_at = now(), reviewed_by_user_id = $2, review_note = $3 WHERE id = $1',
    [id, ids.supervisor, note],
  );

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 3 });
  for (const id of [ids.guard, ids.supervisor]) {
    await app.query(
      `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, 'Offline Tester', now())`,
      [id, `offline-${id}@example.test`],
    );
  }
  await inTenant(ids.org, async (c) => {
    await c.query(
      `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
       VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
      [ids.org, `offline-${ids.org.slice(0, 8)}`],
    );
    await c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Gatehouse', 'OF', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    );
  });
});

afterAll(async () => {
  await app?.end();
});

describe('entries recorded after the fact', () => {
  it('keep the time they happened and need the device reference', async () => {
    await inTenant(ids.org, (c) => record(c, { hoursAgo: 3 }));
    await inTenant(ids.org, (c) => record(c, { source: 'PAPER', hoursAgo: 30 }));
    await expect(inTenant(ids.org, (c) => record(c, { clientRef: null }))).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('are recorded once per device reference (a retried sync is not a second visit)', async () => {
    const ref = randomUUID();
    await inTenant(ids.org, (c) => record(c, { clientRef: ref }));
    await expect(inTenant(ids.org, (c) => record(c, { clientRef: ref }))).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('can be flagged; live admissions cannot', async () => {
    await inTenant(ids.org, (c) => record(c, { reviewReason: 'REVOKED' }));
    await expect(
      inTenant(ids.org, (c) => record(c, { reviewReason: 'not a code' })),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      inTenant(ids.org, (c) =>
        record(c, { source: 'ONLINE', hoursAgo: 0, clientRef: null, reviewReason: 'REVOKED' }),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('supervisor review', () => {
  it('is recorded once, with who and when, and only on a flagged entry', async () => {
    const plain = await inTenant(ids.org, (c) => record(c));
    await expect(inTenant(ids.org, (c) => review(c, plain))).rejects.toMatchObject({
      code: '23514',
    });

    const flagged = await inTenant(ids.org, (c) => record(c, { reviewReason: 'EXPIRED' }));
    await inTenant(ids.org, (c) => review(c, flagged));
    await expect(
      inTenant(ids.org, (c) => review(c, flagged, 'A different story')),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('leaves the record itself unchangeable, and the departure still recordable once', async () => {
    const flagged = await inTenant(ids.org, (c) => record(c, { reviewReason: 'NO_ENTRIES_LEFT' }));
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`UPDATE visits SET review_reason = NULL WHERE id = $1`, [flagged]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await inTenant(ids.org, (c) => review(c, flagged));
    await inTenant(ids.org, (c) =>
      c.query(
        `UPDATE visits SET departed_at = now() - interval '1 hour', departure_recorded_by_user_id = $2 WHERE id = $1`,
        [flagged, ids.guard],
      ),
    );
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`UPDATE visits SET departed_at = now() WHERE id = $1`, [flagged]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Residents (migration 20261109150000_residents): tenant isolation, composite keys, share sums,
 * effective-dating rules, voiding instead of deleting. Runs as veyra_app.
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
    await client.query('COMMIT'); // deferred share-sum check runs here
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const ids = {
  orgA: randomUUID(),
  orgB: randomUUID(),
  propA: randomUUID(),
  propB: randomUUID(),
  unit1: randomUUID(),
  unit2: randomUUID(),
  unit3: randomUUID(),
  unit4: randomUUID(),
  unitB: randomUUID(),
  ann: randomUUID(),
  ben: randomUUID(),
  cal: randomUUID(),
  personB: randomUUID(),
};

const own = (
  c: pg.PoolClient,
  unit: string,
  person: string,
  num: number,
  den: number,
  from: string,
  to: string | null = null,
  org = ids.orgA,
  prop = ids.propA,
) =>
  c.query(
    `INSERT INTO ownerships (id, organisation_id, property_id, unit_id, person_id, share_numerator, share_denominator, effective_from, effective_to, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now()) RETURNING id`,
    [randomUUID(), org, prop, unit, person, num, den, from, to],
  );

const tenancy = (
  c: pg.PoolClient,
  unit: string,
  start: string,
  end: string | null,
  id = randomUUID(),
) =>
  c
    .query(
      `INSERT INTO tenancies (id, organisation_id, property_id, unit_id, start_date, end_date, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [id, ids.orgA, ids.propA, unit, start, end],
    )
    .then(() => id);

const person = (
  c: pg.PoolClient,
  org: string,
  id: string,
  name: string,
  extra: { email?: string; phone?: string; language?: string } = {},
) =>
  c.query(
    `INSERT INTO persons (id, organisation_id, full_name, email, phone, preferred_language, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [id, org, name, extra.email ?? null, extra.phone ?? null, extra.language ?? null],
  );

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 3 });
  for (const [org, prop, units] of [
    [ids.orgA, ids.propA, [ids.unit1, ids.unit2, ids.unit3, ids.unit4]],
    [ids.orgB, ids.propB, [ids.unitB]],
  ] as const) {
    await inTenant(org, async (c) => {
      await c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `res-${org.slice(0, 8)}`],
      );
      await c.query(
        `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
         VALUES ($1, $2, 'Residence', 'RES', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
        [prop, org],
      );
      for (const [i, unit] of units.entries()) {
        await c.query(
          `INSERT INTO units (id, organisation_id, property_id, number, type, updated_at)
           VALUES ($1, $2, $3, $4, 'APARTMENT', now())`,
          [unit, org, prop, `U${i + 1}`],
        );
      }
    });
  }
  await inTenant(ids.orgA, async (c) => {
    await person(c, ids.orgA, ids.ann, 'Ann Owner', {
      email: 'ann@example.test',
      phone: '+923001234567',
      language: 'ur-PK',
    });
    await person(c, ids.orgA, ids.ben, 'Ben Owner');
    await person(c, ids.orgA, ids.cal, 'Cal Owner');
  });
  await inTenant(ids.orgB, (c) => person(c, ids.orgB, ids.personB, 'Other Tenant Person'));
});

afterAll(async () => {
  await app?.end();
});

describe('tenant isolation', () => {
  it.each([
    'persons',
    'ownerships',
    'tenancies',
    'tenancy_occupants',
    'household_members',
    'emergency_contacts',
    'vehicles',
  ])('shows nothing in %s without tenant context', async (table) => {
    const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${table}`);
    expect(rows[0].n).toBe(0);
  });

  it('shows a tenant only its own people', async () => {
    const names = await inTenant(ids.orgA, async (c) =>
      (await c.query('SELECT full_name FROM persons ORDER BY full_name')).rows.map(
        (r) => r.full_name,
      ),
    );
    expect(names).toEqual(['Ann Owner', 'Ben Owner', 'Cal Owner']);
  });

  it("rejects an ownership pointing at another tenant's unit or person", async () => {
    await expect(
      inTenant(ids.orgA, (c) =>
        own(c, ids.unitB, ids.ann, 1, 1, '2026-01-01', null, ids.orgA, ids.propB),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      inTenant(ids.orgA, (c) => own(c, ids.unit1, ids.personB, 1, 1, '2026-01-01')),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('ownership shares (checked at commit)', () => {
  it('accepts a sole owner and exact thirds', async () => {
    await inTenant(ids.orgA, (c) => own(c, ids.unit1, ids.ann, 1, 1, '2026-01-01'));
    await inTenant(ids.orgA, async (c) => {
      for (const p of [ids.ann, ids.ben, ids.cal]) await own(c, ids.unit2, p, 1, 3, '2026-01-01');
    });
  });

  it('rejects shares that do not add up to one', async () => {
    await expect(
      inTenant(ids.orgA, (c) => own(c, ids.unit3, ids.ann, 1, 2, '2026-01-01')),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      inTenant(ids.orgA, async (c) => {
        await own(c, ids.unit3, ids.ann, 1, 2, '2026-01-01');
        await own(c, ids.unit3, ids.ben, 2, 3, '2026-01-01');
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('allows a transfer in one transaction, and rejects one that overlaps', async () => {
    await inTenant(ids.orgA, (c) => own(c, ids.unit3, ids.ann, 1, 1, '2026-01-01'));
    await inTenant(ids.orgA, async (c) => {
      await c.query(`UPDATE ownerships SET effective_to = '2026-12-31' WHERE unit_id = $1`, [
        ids.unit3,
      ]);
      await own(c, ids.unit3, ids.ben, 1, 1, '2027-01-01');
    });
    // Ben's ownership starting before Ann's ends would make two full owners at once.
    await expect(
      inTenant(ids.orgA, (c) => own(c, ids.unit3, ids.cal, 1, 1, '2026-12-15', '2026-12-20')),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects overlapping ownerships of the same person, and invalid fractions', async () => {
    await expect(
      inTenant(ids.orgA, (c) => own(c, ids.unit1, ids.ann, 1, 1, '2026-06-01')),
    ).rejects.toMatchObject({ code: '23P01' });
    await expect(
      inTenant(ids.orgA, (c) => own(c, ids.unit4, ids.ann, 3, 2, '2026-01-01')),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      inTenant(ids.orgA, (c) => own(c, ids.unit4, ids.ann, 0, 1, '2026-01-01')),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('ignores voided ownerships, which need a reason', async () => {
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query(`UPDATE ownerships SET voided_at = now() WHERE unit_id = $1`, [ids.unit1]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await inTenant(ids.orgA, async (c) => {
      await c.query(
        `UPDATE ownerships SET voided_at = now(), void_reason = 'Entered on the wrong unit' WHERE unit_id = $1`,
        [ids.unit1],
      );
      await own(c, ids.unit1, ids.ben, 1, 1, '2026-01-01');
    });
  });

  it('can never be deleted', async () => {
    await expect(
      inTenant(ids.orgA, (c) => c.query('DELETE FROM ownerships')),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('tenancies', () => {
  it('allows one tenancy per unit at a time, with inclusive end dates', async () => {
    const first = await inTenant(ids.orgA, (c) =>
      tenancy(c, ids.unit4, '2026-01-01', '2026-06-30'),
    );
    await inTenant(ids.orgA, (c) => tenancy(c, ids.unit4, '2026-07-01', null));
    // Sharing the last day of the first tenancy is an overlap.
    await expect(
      inTenant(ids.orgA, (c) => tenancy(c, ids.unit4, '2026-06-30', '2026-06-30')),
    ).rejects.toMatchObject({ code: '23P01' });
    // A voided tenancy no longer blocks the period.
    await inTenant(ids.orgA, (c) =>
      c.query(
        `UPDATE tenancies SET voided_at = now(), void_reason = 'Duplicate entry' WHERE id = $1`,
        [first],
      ),
    );
    await inTenant(ids.orgA, (c) => tenancy(c, ids.unit4, '2026-03-01', '2026-06-30'));
  });

  it('allows at most one primary tenant per tenancy', async () => {
    const id = await inTenant(ids.orgA, (c) => tenancy(c, ids.unit1, '2026-01-01', null));
    const add = (p: string, primary: boolean) =>
      inTenant(ids.orgA, (c) =>
        c.query(
          `INSERT INTO tenancy_occupants (id, organisation_id, tenancy_id, person_id, is_primary) VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), ids.orgA, id, p, primary],
        ),
      );
    await add(ids.ann, true);
    await add(ids.ben, false);
    await expect(add(ids.cal, true)).rejects.toMatchObject({ code: '23505' });
    await expect(add(ids.ann, false)).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects an end date before the start date', async () => {
    await expect(
      inTenant(ids.orgA, (c) => tenancy(c, ids.unit2, '2026-05-01', '2026-04-30')),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('household members, contacts and vehicles', () => {
  it('rejects overlapping household periods for the same person and unit', async () => {
    const add = (from: string, to: string | null) =>
      inTenant(ids.orgA, (c) =>
        c.query(
          `INSERT INTO household_members (id, organisation_id, property_id, unit_id, person_id, relationship, valid_from, valid_to, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'CHILD', $6, $7, now())`,
          [randomUUID(), ids.orgA, ids.propA, ids.unit2, ids.cal, from, to],
        ),
      );
    await add('2026-01-01', '2026-12-31');
    await expect(add('2026-12-31', null)).rejects.toMatchObject({ code: '23P01' });
    await add('2027-01-01', null);
  });

  it('validates people: unique email per organisation, E.164 phone, language tag', async () => {
    await expect(
      inTenant(ids.orgA, (c) =>
        person(c, ids.orgA, randomUUID(), 'Copy', { email: 'ann@example.test' }),
      ),
    ).rejects.toMatchObject({ code: '23505' });
    for (const extra of [
      { email: 'Mixed@Example.test' },
      { phone: '03001234567' },
      { language: 'english!' },
    ]) {
      await expect(
        inTenant(ids.orgA, (c) => person(c, ids.orgA, randomUUID(), 'Bad', extra)),
      ).rejects.toMatchObject({ code: '23514' });
    }
    // The same email in another organisation is a different profile.
    await inTenant(ids.orgB, (c) =>
      person(c, ids.orgB, randomUUID(), 'Ann Elsewhere', { email: 'ann@example.test' }),
    );
  });

  it('lets emergency contacts be deleted, unlike history', async () => {
    await inTenant(ids.orgA, async (c) => {
      await c.query(
        `INSERT INTO emergency_contacts (id, organisation_id, person_id, name, phone, updated_at) VALUES ($1, $2, $3, 'Dad', '+923009998887', now())`,
        [randomUUID(), ids.orgA, ids.ann],
      );
      const { rowCount } = await c.query('DELETE FROM emergency_contacts WHERE person_id = $1', [
        ids.ann,
      ]);
      expect(rowCount).toBe(1);
    });
  });

  it('keeps active plates unique per property and frees them when archived', async () => {
    const add = (plate: string) =>
      inTenant(ids.orgA, (c) =>
        c.query(
          `INSERT INTO vehicles (id, organisation_id, property_id, unit_id, plate, updated_at) VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
          [randomUUID(), ids.orgA, ids.propA, ids.unit1, plate],
        ),
      );
    const first = (await add('LEA-1234')).rows[0].id;
    await expect(add('LEA-1234')).rejects.toMatchObject({ code: '23505' });
    await expect(add('lea 1234')).rejects.toMatchObject({ code: '23514' });
    await inTenant(ids.orgA, (c) =>
      c.query(`UPDATE vehicles SET status = 'ARCHIVED', archived_at = now() WHERE id = $1`, [
        first,
      ]),
    );
    await add('LEA-1234');
  });
});

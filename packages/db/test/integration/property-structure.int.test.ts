import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDbClient, withTenantTransaction } from '../../src';

/**
 * Property structure (migration 20261109090000_property_structure): tenant isolation,
 * composite tenant foreign keys, integrity rules and the membership scope trigger. Runs as
 * veyra_app, the role the API uses.
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
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const ids = {
  orgA: randomUUID(),
  orgB: randomUUID(),
  propA1: randomUUID(),
  propA2: randomUUID(),
  propB1: randomUUID(),
  bldA1: randomUUID(), // in propA1
  bldA2: randomUUID(), // in propA2
  bldB1: randomUUID(), // in propB1
  floorA1: randomUUID(), // in bldA1
  floorA2: randomUUID(), // in bldA2
  user: randomUUID(),
};

const insertProperty = (c: pg.PoolClient, org: string, id: string, code: string) =>
  c.query(
    `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
     VALUES ($1, $2, $3, $4, 'CONDOMINIUM', '1 Shore Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
    [id, org, `Property ${code}`, code],
  );

const insertBuilding = (
  c: pg.PoolClient,
  org: string,
  property: string,
  id: string,
  code: string,
) =>
  c.query(
    `INSERT INTO buildings (id, organisation_id, property_id, name, code, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [id, org, property, `Tower ${code}`, code],
  );

const insertFloor = (
  c: pg.PoolClient,
  org: string,
  property: string,
  building: string,
  id: string,
  level: number,
) =>
  c.query(
    `INSERT INTO floors (id, organisation_id, property_id, building_id, level, name, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [id, org, property, building, level, `Level ${level}`],
  );

const insertUnit = (
  c: pg.PoolClient,
  org: string,
  property: string,
  building: string | null,
  floor: string | null,
  number: string,
) =>
  c.query(
    `INSERT INTO units (id, organisation_id, property_id, building_id, floor_id, number, type, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'APARTMENT', now())`,
    [randomUUID(), org, property, building, floor, number],
  );

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 3 });
  await app.query(
    `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, 'Scope Tester', now())`,
    [ids.user, `scope-${ids.user}@example.test`],
  );
  for (const [org, slug] of [
    [ids.orgA, `struct-a-${ids.orgA.slice(0, 8)}`],
    [ids.orgB, `struct-b-${ids.orgB.slice(0, 8)}`],
  ] as const) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, slug],
      ),
    );
  }
  await inTenant(ids.orgA, async (c) => {
    await insertProperty(c, ids.orgA, ids.propA1, 'HVR');
    await insertProperty(c, ids.orgA, ids.propA2, 'LKS');
    await insertBuilding(c, ids.orgA, ids.propA1, ids.bldA1, 'A');
    await insertBuilding(c, ids.orgA, ids.propA2, ids.bldA2, 'A');
    await insertFloor(c, ids.orgA, ids.propA1, ids.bldA1, ids.floorA1, 1);
    await insertFloor(c, ids.orgA, ids.propA2, ids.bldA2, ids.floorA2, 1);
    await insertUnit(c, ids.orgA, ids.propA1, ids.bldA1, ids.floorA1, '101');
  });
  await inTenant(ids.orgB, async (c) => {
    await insertProperty(c, ids.orgB, ids.propB1, 'HVR');
    await insertBuilding(c, ids.orgB, ids.propB1, ids.bldB1, 'A');
  });
});

afterAll(async () => {
  await app?.end();
});

describe('tenant isolation', () => {
  it.each(['properties', 'buildings', 'floors', 'units', 'common_areas'])(
    'shows nothing in %s without tenant context',
    async (table) => {
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n).toBe(0);
    },
  );

  it("shows a tenant only its own structure, even with the same codes as another tenant's", async () => {
    const seen = await inTenant(ids.orgA, async (c) => ({
      properties: (await c.query('SELECT id FROM properties ORDER BY code')).rows.map((r) => r.id),
      buildings: (await c.query('SELECT count(*)::int AS n FROM buildings')).rows[0].n,
    }));
    expect(seen).toEqual({ properties: [ids.propA1, ids.propA2], buildings: 2 });
  });

  it('cannot write rows for another tenant (RLS)', async () => {
    await expect(
      inTenant(ids.orgA, (c) => insertBuilding(c, ids.orgB, ids.propB1, randomUUID(), 'Z')),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot delete structure at all (archive instead)', async () => {
    await expect(inTenant(ids.orgA, (c) => c.query('DELETE FROM units'))).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('composite tenant foreign keys', () => {
  it("rejects a building that points at another tenant's property", async () => {
    await expect(
      inTenant(ids.orgA, (c) => insertBuilding(c, ids.orgA, ids.propB1, randomUUID(), 'X')),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects a floor whose building belongs to a different property', async () => {
    await expect(
      inTenant(ids.orgA, (c) => insertFloor(c, ids.orgA, ids.propA1, ids.bldA2, randomUUID(), 5)),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects a unit in a building of a different property of the same tenant', async () => {
    await expect(
      inTenant(ids.orgA, (c) => insertUnit(c, ids.orgA, ids.propA1, ids.bldA2, null, '1')),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it("rejects a unit on another building's floor", async () => {
    await expect(
      inTenant(ids.orgA, (c) => insertUnit(c, ids.orgA, ids.propA1, ids.bldA1, ids.floorA2, '2')),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects a floor without a building (the floor key would otherwise go unchecked)', async () => {
    await expect(
      inTenant(ids.orgA, (c) => insertUnit(c, ids.orgA, ids.propA1, null, ids.floorA1, '3')),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('cannot move a property to another tenant', async () => {
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query('UPDATE properties SET organisation_id = $1 WHERE id = $2', [ids.orgB, ids.propA2]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('integrity rules', () => {
  it('keeps unit numbers unique per building, case-insensitively', async () => {
    await expect(
      inTenant(ids.orgA, (c) => insertUnit(c, ids.orgA, ids.propA1, ids.bldA1, null, '101')),
    ).rejects.toMatchObject({ code: '23505' });
    await inTenant(ids.orgA, (c) => insertUnit(c, ids.orgA, ids.propA1, ids.bldA1, null, '12B'));
    await expect(
      inTenant(ids.orgA, (c) => insertUnit(c, ids.orgA, ids.propA1, ids.bldA1, null, '12b')),
    ).rejects.toMatchObject({ code: '23505' });
    // The same number in another property is fine.
    await inTenant(ids.orgA, (c) => insertUnit(c, ids.orgA, ids.propA2, ids.bldA2, null, '101'));
  });

  it('treats units without a building as one group per property (villas)', async () => {
    await inTenant(ids.orgA, (c) => insertUnit(c, ids.orgA, ids.propA2, null, null, 'Villa 7'));
    await expect(
      inTenant(ids.orgA, (c) => insertUnit(c, ids.orgA, ids.propA2, null, null, 'VILLA 7')),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it.each([
    ['lower-case code', 'hvr2'],
    ['code with spaces', 'H V'],
    ['too short code', 'H'],
  ])('rejects a property with a %s', async (_label, code) => {
    await expect(
      inTenant(ids.orgA, (c) => insertProperty(c, ids.orgA, randomUUID(), code)),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('requires archived_at exactly when archived', async () => {
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query(`UPDATE buildings SET status = 'ARCHIVED' WHERE id = $1`, [ids.bldA1]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await inTenant(ids.orgA, (c) =>
      c.query(`UPDATE floors SET status = 'ARCHIVED', archived_at = now() WHERE id = $1`, [
        ids.floorA2,
      ]),
    );
  });

  it('rejects non-positive areas and floor levels out of range', async () => {
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query(`UPDATE units SET area_sqm = 0 WHERE property_id = $1`, [ids.propA1]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      inTenant(ids.orgA, (c) => insertFloor(c, ids.orgA, ids.propA1, ids.bldA1, randomUUID(), 999)),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('membership and invitation scopes', () => {
  const insertMembership = (c: pg.PoolClient, org: string, scopeType: string, scopeId: string) =>
    c.query(
      `INSERT INTO memberships (id, organisation_id, user_id, role, scope_type, scope_id, updated_at)
       VALUES ($1, $2, $3, 'PROPERTY_MANAGER', $4, $5, now())`,
      [randomUUID(), org, ids.user, scopeType, scopeId],
    );

  it('accepts a property scope of the same organisation', async () => {
    await inTenant(ids.orgA, (c) => insertMembership(c, ids.orgA, 'PROPERTY', ids.propA1));
  });

  it('rejects a property scope of another organisation, or one that does not exist', async () => {
    for (const scope of [ids.propB1, randomUUID()]) {
      await expect(
        inTenant(ids.orgA, (c) => insertMembership(c, ids.orgA, 'PROPERTY', scope)),
      ).rejects.toMatchObject({ code: '23503' });
    }
  });

  it('checks building and unit scopes the same way', async () => {
    await inTenant(ids.orgA, (c) => insertMembership(c, ids.orgA, 'BUILDING', ids.bldA2));
    await expect(
      inTenant(ids.orgA, (c) => insertMembership(c, ids.orgA, 'BUILDING', ids.bldB1)),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      inTenant(ids.orgA, (c) => insertMembership(c, ids.orgA, 'UNIT', ids.propA1)),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('applies to invitations too', async () => {
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query(
          `INSERT INTO invitations (id, organisation_id, email, role, scope_type, scope_id, token_hash, expires_at, invited_by_id)
           VALUES ($1, $2, 'pm@example.test', 'PROPERTY_MANAGER', 'PROPERTY', $3, $4, now() + interval '7 days', $5)`,
          [randomUUID(), ids.orgA, ids.propB1, randomUUID(), ids.user],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('through Prisma', () => {
  it('reads the structure with relations inside the tenant context', async () => {
    const db = createDbClient(inject('appDatabaseUrl'));
    try {
      const property = await withTenantTransaction(db, { organisationId: ids.orgA }, (tx) =>
        tx.property.findUniqueOrThrow({
          where: { id: ids.propA1 },
          include: { buildings: { include: { floors: { include: { units: true } } } } },
        }),
      );
      expect(property.code).toBe('HVR');
      expect(property.buildings[0]?.floors[0]?.units.map((u) => u.number)).toEqual(['101']);
      expect(await db.property.count()).toBe(0);
    } finally {
      await db.$disconnect();
    }
  });
});

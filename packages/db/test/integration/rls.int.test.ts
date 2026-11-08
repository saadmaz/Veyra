import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDbClient, withTenantTransaction, withUserTransaction } from '../../src';

/**
 * Proves tenant isolation at the database layer (docs/architecture/MULTI_TENANCY.md, layer 3):
 * these run as veyra_app, the role the API uses, against the real migrations.
 */

type Context = { organisationId?: string; userId?: string };

let app: pg.Pool;
let owner: pg.Pool;

async function inContext<T>(
  pool: pg.Pool,
  context: Context,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (context.organisationId) {
      await client.query("SELECT set_config('app.organisation_id', $1, true)", [
        context.organisationId,
      ]);
    }
    if (context.userId) {
      await client.query("SELECT set_config('app.user_id', $1, true)", [context.userId]);
    }
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
  alice: randomUUID(), // member of A only
  bob: randomUUID(), // member of B only
  carol: randomUUID(), // member of A and B
};

async function createOrganisation(id: string, slug: string) {
  await inContext(app, { organisationId: id }, (c) =>
    c.query(
      `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
       VALUES ($1, $2, $3, 'PK', 'PKR', 'Asia/Karachi', now())`,
      [id, slug, slug],
    ),
  );
}

async function addMembership(organisationId: string, userId: string, role: string) {
  await inContext(app, { organisationId }, (c) =>
    c.query(
      `INSERT INTO memberships (id, organisation_id, user_id, role, scope_type, scope_id, updated_at)
       VALUES ($1, $2, $3, $4, 'ORGANISATION', $2, now())`,
      [randomUUID(), organisationId, userId, role],
    ),
  );
}

const count = async (client: pg.PoolClient, table: string) =>
  Number((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 4 });
  owner = new pg.Pool({ connectionString: inject('ownerDatabaseUrl'), max: 2 });

  for (const [id, email] of [
    [ids.alice, 'alice@example.test'],
    [ids.bob, 'bob@example.test'],
    [ids.carol, 'carol@example.test'],
  ] as const) {
    await app.query(
      `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, $2, now())`,
      [id, email],
    );
  }

  await createOrganisation(ids.orgA, 'tenant-a');
  await createOrganisation(ids.orgB, 'tenant-b');
  await addMembership(ids.orgA, ids.alice, 'ORGANISATION_ADMIN');
  await addMembership(ids.orgB, ids.bob, 'ORGANISATION_ADMIN');
  await addMembership(ids.orgA, ids.carol, 'FINANCE_OFFICER');
  await addMembership(ids.orgB, ids.carol, 'FINANCE_OFFICER');

  for (const organisationId of [ids.orgA, ids.orgB]) {
    await inContext(app, { organisationId }, (c) =>
      c.query(
        `INSERT INTO invitations (id, organisation_id, email, role, scope_type, scope_id, token_hash, expires_at, invited_by_id)
         VALUES ($1, $2, $3, 'TENANT', 'ORGANISATION', $2, $4, now() + interval '7 days', $5)`,
        [
          randomUUID(),
          organisationId,
          `invitee-${organisationId}@example.test`,
          randomUUID(),
          ids.alice,
        ],
      ),
    );
    await inContext(app, { organisationId }, (c) =>
      c.query(
        `INSERT INTO audit_logs (id, organisation_id, action, resource_type) VALUES ($1, $2, 'organisation.created', 'organisation')`,
        [randomUUID(), organisationId],
      ),
    );
  }
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
});

describe('database roles', () => {
  it('the application role is neither superuser nor able to bypass RLS', async () => {
    const { rows } = await app.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('the application role cannot read the migrations table', async () => {
    await expect(app.query('SELECT * FROM _prisma_migrations')).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('without tenant context', () => {
  it.each(['organisations', 'memberships', 'invitations', 'audit_logs'])(
    'sees no rows in %s',
    async (table) => {
      expect(await inContext(app, {}, (c) => count(c, table))).toBe(0);
    },
  );

  it('also hides everything from the schema owner (FORCE ROW LEVEL SECURITY)', async () => {
    expect(await inContext(owner, {}, (c) => count(c, 'organisations'))).toBe(0);
  });
});

describe('inside tenant A', () => {
  const tenantA = { organisationId: ids.orgA };

  it('sees only its own organisation, memberships, invitations and audit records', async () => {
    await inContext(app, tenantA, async (c) => {
      expect((await c.query('SELECT id FROM organisations')).rows).toEqual([{ id: ids.orgA }]);
      const memberships = await c.query('SELECT DISTINCT organisation_id FROM memberships');
      expect(memberships.rows).toEqual([{ organisation_id: ids.orgA }]);
      expect(await count(c, 'memberships')).toBe(2);
      expect(await count(c, 'invitations')).toBe(1);
      expect(await count(c, 'audit_logs')).toBe(1);
    });
  });

  it('cannot insert a membership into tenant B', async () => {
    await expect(
      inContext(app, tenantA, (c) =>
        c.query(
          `INSERT INTO memberships (id, organisation_id, user_id, role, scope_type, scope_id, updated_at)
           VALUES ($1, $2, $3, 'OWNER', 'ORGANISATION', $2, now())`,
          [randomUUID(), ids.orgB, ids.alice],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot update tenant B (the row is invisible, so nothing changes)', async () => {
    const result = await inContext(app, tenantA, (c) =>
      c.query(`UPDATE organisations SET name = 'hijacked' WHERE id = $1`, [ids.orgB]),
    );
    expect(result.rowCount).toBe(0);
    const name = await inContext(
      app,
      { organisationId: ids.orgB },
      async (c) => (await c.query('SELECT name FROM organisations')).rows[0].name,
    );
    expect(name).toBe('tenant-b');
  });

  it('cannot move its own row into another tenant', async () => {
    await expect(
      inContext(app, tenantA, (c) =>
        c.query(`UPDATE memberships SET organisation_id = $1 WHERE organisation_id = $2`, [
          ids.orgB,
          ids.orgA,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot delete organisations at all (no privilege)', async () => {
    await expect(
      inContext(app, tenantA, (c) => c.query('DELETE FROM organisations')),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('user context (no organisation chosen yet)', () => {
  it('lists every organisation the user actively belongs to, and nothing else', async () => {
    const orgs = await inContext(app, { userId: ids.carol }, async (c) =>
      (await c.query('SELECT id FROM organisations ORDER BY slug')).rows.map((r) => r.id),
    );
    expect(orgs).toEqual([ids.orgA, ids.orgB]);

    const aliceOrgs = await inContext(app, { userId: ids.alice }, async (c) =>
      (await c.query('SELECT id FROM organisations')).rows.map((r) => r.id),
    );
    expect(aliceOrgs).toEqual([ids.orgA]);
  });

  it("sees only the user's own memberships, not colleagues'", async () => {
    const rows = await inContext(
      app,
      { userId: ids.carol },
      async (c) => (await c.query('SELECT DISTINCT user_id FROM memberships')).rows,
    );
    expect(rows).toEqual([{ user_id: ids.carol }]);
  });

  it('loses access to an organisation when the membership is suspended', async () => {
    await inContext(app, { organisationId: ids.orgB }, (c) =>
      c.query(`UPDATE memberships SET status = 'SUSPENDED' WHERE user_id = $1`, [ids.carol]),
    );
    const orgs = await inContext(app, { userId: ids.carol }, async (c) =>
      (await c.query('SELECT id FROM organisations')).rows.map((r) => r.id),
    );
    expect(orgs).toEqual([ids.orgA]);
    await inContext(app, { organisationId: ids.orgB }, (c) =>
      c.query(`UPDATE memberships SET status = 'ACTIVE' WHERE user_id = $1`, [ids.carol]),
    );
  });
});

describe('context isolation on pooled connections', () => {
  it('does not leak tenant context into the next transaction on the same connection', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organisation_id', $1, true)", [ids.orgA]);
      expect(await count(client, 'organisations')).toBe(1);
      await client.query('COMMIT');

      await client.query('BEGIN');
      expect(await count(client, 'organisations')).toBe(0);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });
});

describe('audit log', () => {
  it('accepts platform events without tenant context but never shows them to tenants', async () => {
    await app.query(
      `INSERT INTO audit_logs (id, organisation_id, action, resource_type) VALUES ($1, NULL, 'auth.sign_in', 'session')`,
      [randomUUID()],
    );
    expect(
      await inContext(app, { organisationId: ids.orgA }, async (c) =>
        Number(
          (await c.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'auth.sign_in'`))
            .rows[0].n,
        ),
      ),
    ).toBe(0);
  });

  it('rejects tenant events written for another tenant', async () => {
    await expect(
      inContext(app, { organisationId: ids.orgA }, (c) =>
        c.query(
          `INSERT INTO audit_logs (id, organisation_id, action, resource_type) VALUES ($1, $2, 'x', 'y')`,
          [randomUUID(), ids.orgB],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot be modified by the application role', async () => {
    await expect(
      inContext(app, { organisationId: ids.orgA }, (c) =>
        c.query(`UPDATE audit_logs SET action = 'tampered'`),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot be deleted by the schema owner (no delete policy, so nothing matches)', async () => {
    const result = await inContext(owner, { organisationId: ids.orgA }, (c) =>
      c.query('DELETE FROM audit_logs'),
    );
    expect(result.rowCount).toBe(0);
    expect(await inContext(app, { organisationId: ids.orgA }, (c) => count(c, 'audit_logs'))).toBe(
      1,
    );
  });

  it('cannot be modified even by a superuser that bypasses RLS (append-only trigger)', async () => {
    const superuser = new pg.Client({ connectionString: inject('superuserDatabaseUrl') });
    await superuser.connect();
    try {
      await expect(superuser.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
      await expect(superuser.query(`UPDATE audit_logs SET action = 'x'`)).rejects.toThrow(
        /append-only/,
      );
      await expect(superuser.query('TRUNCATE audit_logs')).rejects.toThrow(/append-only/);
    } finally {
      await superuser.end();
    }
  });
});

describe('data integrity constraints', () => {
  it('rejects non-normalised email addresses', async () => {
    await expect(
      app.query(
        `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, 'Mixed@Example.test', 'x', now())`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects organisation-scoped memberships whose scope is a different organisation', async () => {
    await expect(
      inContext(app, { organisationId: ids.orgA }, (c) =>
        c.query(
          `INSERT INTO memberships (id, organisation_id, user_id, role, scope_type, scope_id, updated_at)
           VALUES ($1, $2, $3, 'OWNER', 'ORGANISATION', $4, now())`,
          [randomUUID(), ids.orgA, ids.bob, ids.orgB],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('through Prisma (createDbClient + withTenantTransaction)', () => {
  it('applies the same isolation to the generated client', async () => {
    const db = createDbClient(inject('appDatabaseUrl'));
    try {
      const orgs = await withTenantTransaction(db, { organisationId: ids.orgA }, (tx) =>
        tx.organisation.findMany({ select: { id: true } }),
      );
      expect(orgs).toEqual([{ id: ids.orgA }]);

      const mine = await withUserTransaction(db, ids.carol, (tx) =>
        tx.organisation.findMany({ select: { slug: true }, orderBy: { slug: 'asc' } }),
      );
      expect(mine.map((o) => o.slug)).toEqual(['tenant-a', 'tenant-b']);

      expect(await db.organisation.count()).toBe(0);
    } finally {
      await db.$disconnect();
    }
  });
});

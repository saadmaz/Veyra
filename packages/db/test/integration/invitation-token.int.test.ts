import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDbClient, withInvitationTokenTransaction } from '../../src';

/** RLS for invitation acceptance (migration 20261108160000_invitation_token_lookup). */

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
let app: pg.Pool;
const orgId = randomUUID();
const inviterId = randomUUID();
const tokenA = randomUUID();
const tokenB = randomUUID();

async function inTenant<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [orgId]);
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

const insertInvitation = (c: pg.PoolClient, email: string, role: string, token: string) =>
  c.query(
    `INSERT INTO invitations (id, organisation_id, email, role, scope_type, scope_id, token_hash, expires_at, invited_by_id)
     VALUES ($1, $2, $3, $4, 'ORGANISATION', $2, $5, now() + interval '7 days', $6)`,
    [randomUUID(), orgId, email, role, sha256(token), inviterId],
  );

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 2 });
  await inTenant(async (c) => {
    await c.query(
      `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
       VALUES ($1, 'Invites', $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
      [orgId, `invites-${orgId.slice(0, 8)}`],
    );
    await insertInvitation(c, 'a@example.test', 'FINANCE_OFFICER', tokenA);
    await insertInvitation(c, 'b@example.test', 'FINANCE_OFFICER', tokenB);
  });
});

afterAll(async () => {
  await app?.end();
});

describe('invitation lookup by token hash', () => {
  it('without context nothing is visible', async () => {
    const { rows } = await app.query('SELECT count(*)::int AS n FROM invitations');
    expect(rows[0].n).toBe(0);
  });

  it('a presented token hash exposes exactly its own invitation', async () => {
    const db = createDbClient(inject('appDatabaseUrl'));
    try {
      const visible = await withInvitationTokenTransaction(db, sha256(tokenA), (tx) =>
        tx.invitation.findMany({ select: { email: true } }),
      );
      expect(visible).toEqual([{ email: 'a@example.test' }]);

      const none = await withInvitationTokenTransaction(db, sha256('wrong'), (tx) =>
        tx.invitation.count(),
      );
      expect(none).toBe(0);
    } finally {
      await db.$disconnect();
    }
  });

  it('a token hash grants read access only: no updates without tenant context', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.invitation_token_hash', $1, true)", [
        sha256(tokenA),
      ]);
      const result = await client.query(`UPDATE invitations SET revoked_at = now()`);
      expect(result.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('rejects malformed hashes before touching the database', async () => {
    const db = createDbClient(inject('appDatabaseUrl'));
    try {
      await expect(
        withInvitationTokenTransaction(db, "x' OR true --", async () => 0),
      ).rejects.toThrow(/SHA-256/);
    } finally {
      await db.$disconnect();
    }
  });
});

describe('invitation constraints', () => {
  it('allows only one pending invitation per email and role', async () => {
    await expect(
      inTenant((c) => insertInvitation(c, 'a@example.test', 'FINANCE_OFFICER', randomUUID())),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('cannot be both accepted and revoked', async () => {
    await expect(
      inTenant((c) =>
        c.query(
          `UPDATE invitations SET accepted_at = now(), accepted_by_id = $1, revoked_at = now()
            WHERE email = 'b@example.test'`,
          [randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

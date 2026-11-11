import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Visitors (migration 20261111120000_visitors): tenant isolation, composite keys, invitation and
 * pass rules, the online admission backstop (including two gates racing for the last entry),
 * immutable visits and the append-only access log. Runs as veyra_app unless stated.
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
  orgA: randomUUID(),
  orgB: randomUUID(),
  propA: randomUUID(),
  propA2: randomUUID(),
  propB: randomUUID(),
  unit1: randomUUID(),
  unit2: randomUUID(),
  unitA2: randomUUID(),
  unitB: randomUUID(),
  host: randomUUID(),
  guard: randomUUID(),
};

const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

interface InvitationInput {
  org?: string;
  prop?: string;
  unit?: string;
  from?: string;
  until?: string;
  maxEntries?: number;
  phone?: string | null;
  name?: string;
}

const invite = (c: pg.PoolClient, input: InvitationInput = {}) => {
  const id = randomUUID();
  return c
    .query(
      `INSERT INTO visitor_invitations (id, organisation_id, property_id, unit_id, host_person_id, created_by_user_id,
         category, visitor_name, visitor_phone, valid_from, valid_until, max_entries, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'GUEST', $7, $8, $9, $10, $11, now())`,
      [
        id,
        input.org ?? ids.orgA,
        input.prop ?? ids.propA,
        input.unit ?? ids.unit1,
        (input.org ?? ids.orgA) === ids.orgA ? ids.host : null,
        ids.host,
        input.name ?? 'Vera Visitor',
        input.phone ?? null,
        input.from ?? hours(-1),
        input.until ?? hours(1),
        input.maxEntries ?? 1,
      ],
    )
    .then(() => id);
};

const issuePass = (
  c: pg.PoolClient,
  invitationId: string,
  code: string = randomUUID(),
  prop = ids.propA,
) => {
  const id = randomUUID();
  return c
    .query(
      `INSERT INTO visitor_passes (id, organisation_id, property_id, invitation_id, token_hash, code_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, ids.orgA, prop, invitationId, sha(randomUUID()), sha(code)],
    )
    .then(() => id);
};

interface VisitInput {
  invitationId?: string | null;
  passId?: string | null;
  unit?: string | null;
  decision?: 'ADMITTED' | 'DENIED';
  denialReason?: string | null;
  arrivedAt?: string;
  source?: 'ONLINE' | 'PAPER' | 'OFFLINE_SYNC';
}

const visit = (c: pg.PoolClient, input: VisitInput = {}) => {
  const id = randomUUID();
  return c
    .query(
      `INSERT INTO visits (id, organisation_id, property_id, unit_id, invitation_id, pass_id, category,
         visitor_name, decision, denial_reason, arrived_at, recorded_by_user_id, source, client_ref, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'GUEST', 'Vera Visitor', $7, $8, $9, $10, $11, $12, now())`,
      [
        id,
        ids.orgA,
        ids.propA,
        input.unit === undefined ? ids.unit1 : input.unit,
        input.invitationId ?? null,
        input.passId ?? null,
        input.decision ?? 'ADMITTED',
        input.denialReason ?? null,
        input.arrivedAt ?? new Date().toISOString(),
        ids.guard,
        input.source ?? 'ONLINE',
        // Entries recorded after the fact carry the device's reference (Part 5).
        (input.source ?? 'ONLINE') === 'ONLINE' ? null : randomUUID(),
      ],
    )
    .then(() => id);
};

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 4 });
  for (const [id, email] of [
    [ids.host, `host-${ids.host}@example.test`],
    [ids.guard, `guard-${ids.guard}@example.test`],
  ] as const) {
    await app.query(
      `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, 'Visitor Tester', now())`,
      [id, email],
    );
  }
  for (const [org, props] of [
    [
      ids.orgA,
      [
        [ids.propA, 'VA', [ids.unit1, ids.unit2]],
        [ids.propA2, 'VB', [ids.unitA2]],
      ],
    ],
    [ids.orgB, [[ids.propB, 'VC', [ids.unitB]]]],
  ] as const) {
    await inTenant(org, async (c) => {
      await c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `vis-${org.slice(0, 8)}`],
      );
      for (const [prop, code, units] of props) {
        await c.query(
          `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
           VALUES ($1, $2, 'Gatehouse', $3, 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
          [prop, org, code],
        );
        for (const [i, unit] of units.entries()) {
          await c.query(
            `INSERT INTO units (id, organisation_id, property_id, number, type, updated_at)
             VALUES ($1, $2, $3, $4, 'APARTMENT', now())`,
            [unit, org, prop, `G${i + 1}`],
          );
        }
      }
    });
  }
  await inTenant(ids.orgA, (c) =>
    c.query(
      `INSERT INTO persons (id, organisation_id, user_id, full_name, updated_at)
       VALUES ($1, $2, $3, 'Hana Host', now())`,
      [ids.host, ids.orgA, ids.host],
    ),
  );
});

afterAll(async () => {
  await app?.end();
});

describe('tenant isolation', () => {
  it.each(['visitor_invitations', 'visitor_passes', 'visits', 'access_events'])(
    'shows nothing in %s without tenant context',
    async (table) => {
      await inTenant(ids.orgA, (c) => invite(c));
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n).toBe(0);
    },
  );

  it("hides one tenant's invitations from another", async () => {
    const id = await inTenant(ids.orgA, (c) => invite(c));
    const seen = await inTenant(
      ids.orgB,
      async (c) =>
        (await c.query('SELECT id FROM visitor_invitations WHERE id = $1', [id])).rowCount,
    );
    expect(seen).toBe(0);
  });

  it("rejects references to another tenant's or property's records", async () => {
    // An invitation for another tenant's unit.
    await expect(
      inTenant(ids.orgA, (c) => invite(c, { prop: ids.propB, unit: ids.unitB })),
    ).rejects.toMatchObject({ code: '23503' });
    // A pass filed under another property than its invitation.
    const invitation = await inTenant(ids.orgA, (c) => invite(c));
    await expect(
      inTenant(ids.orgA, (c) => issuePass(c, invitation, randomUUID(), ids.propA2)),
    ).rejects.toMatchObject({ code: '23503' });
    // A visit claiming an invitation of another unit.
    await expect(
      inTenant(ids.orgA, (c) => visit(c, { invitationId: invitation, unit: ids.unit2 })),
    ).rejects.toMatchObject({ code: '23503' });
    // An invitation link without a unit would escape the composite key: refused.
    await expect(
      inTenant(ids.orgA, (c) => visit(c, { invitationId: invitation, unit: null })),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('invitations', () => {
  it('rejects bad windows, entry counts and contact data', async () => {
    for (const input of [
      { from: hours(2), until: hours(1) },
      { from: hours(0), until: hours(24 * 32) },
      { maxEntries: 0 },
      { maxEntries: 51 },
      { phone: '0300 1234567' },
      { name: ' padded ' },
    ]) {
      await expect(inTenant(ids.orgA, (c) => invite(c, input))).rejects.toMatchObject({
        code: '23514',
      });
    }
  });

  it('makes revocation final', async () => {
    const id = await inTenant(ids.orgA, (c) => invite(c));
    await inTenant(ids.orgA, (c) =>
      c.query(
        `UPDATE visitor_invitations SET status = 'REVOKED', revoked_at = now(), revoked_by_user_id = $2 WHERE id = $1`,
        [id, ids.host],
      ),
    );
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query(
          `UPDATE visitor_invitations SET status = 'ACTIVE', revoked_at = NULL, revoked_by_user_id = NULL WHERE id = $1`,
          [id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('never moves to another unit', async () => {
    const id = await inTenant(ids.orgA, (c) => invite(c));
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query('UPDATE visitor_invitations SET unit_id = $2 WHERE id = $1', [id, ids.unit2]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('passes', () => {
  it('stores only well-formed hashes', async () => {
    const invitation = await inTenant(ids.orgA, (c) => invite(c));
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query(
          `INSERT INTO visitor_passes (id, organisation_id, property_id, invitation_id, token_hash, code_hash)
           VALUES ($1, $2, $3, $4, 'PLAINTEXT-TOKEN', $5)`,
          [randomUUID(), ids.orgA, ids.propA, invitation, sha('x')],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('allows one live pass per invitation and one live code per property', async () => {
    const first = await inTenant(ids.orgA, (c) => invite(c));
    const second = await inTenant(ids.orgA, (c) => invite(c));
    const pass = await inTenant(ids.orgA, (c) => issuePass(c, first, 'K7Q2-M9XA'));
    await expect(inTenant(ids.orgA, (c) => issuePass(c, first))).rejects.toMatchObject({
      code: '23505',
    });
    await expect(
      inTenant(ids.orgA, (c) => issuePass(c, second, 'K7Q2-M9XA')),
    ).rejects.toMatchObject({ code: '23505' });
    // Revoking frees both: a replacement pass and the code can be issued again.
    await inTenant(ids.orgA, (c) =>
      c.query('UPDATE visitor_passes SET revoked_at = now() WHERE id = $1', [pass]),
    );
    await inTenant(ids.orgA, (c) => issuePass(c, second, 'K7Q2-M9XA'));
    await inTenant(ids.orgA, (c) => issuePass(c, first));
  });

  it('can only be revoked, once', async () => {
    const invitation = await inTenant(ids.orgA, (c) => invite(c));
    const pass = await inTenant(ids.orgA, (c) => issuePass(c, invitation));
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query('UPDATE visitor_passes SET token_hash = $2 WHERE id = $1', [pass, sha('new')]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await inTenant(ids.orgA, (c) =>
      c.query('UPDATE visitor_passes SET revoked_at = now() WHERE id = $1', [pass]),
    );
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query('UPDATE visitor_passes SET revoked_at = NULL WHERE id = $1', [pass]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('online admission backstop', () => {
  it('admits within the window and refuses entries beyond the allowance', async () => {
    const invitation = await inTenant(ids.orgA, (c) => invite(c, { maxEntries: 2 }));
    const pass = await inTenant(ids.orgA, (c) => issuePass(c, invitation));
    await inTenant(ids.orgA, (c) => visit(c, { invitationId: invitation, passId: pass }));
    await inTenant(ids.orgA, (c) => visit(c, { invitationId: invitation, passId: pass }));
    await expect(
      inTenant(ids.orgA, (c) => visit(c, { invitationId: invitation, passId: pass })),
    ).rejects.toMatchObject({ code: '23514' });
    // Denials do not use up entries and are always recordable.
    await inTenant(ids.orgA, (c) =>
      visit(c, { invitationId: invitation, decision: 'DENIED', denialReason: 'No ID shown' }),
    );
  });

  it('refuses invitations outside their window, revoked invitations and revoked passes', async () => {
    const future = await inTenant(ids.orgA, (c) => invite(c, { from: hours(1), until: hours(3) }));
    await expect(
      inTenant(ids.orgA, (c) => visit(c, { invitationId: future })),
    ).rejects.toMatchObject({ code: '23514' });

    const revoked = await inTenant(ids.orgA, (c) => invite(c));
    await inTenant(ids.orgA, (c) =>
      c.query(
        `UPDATE visitor_invitations SET status = 'REVOKED', revoked_at = now() WHERE id = $1`,
        [revoked],
      ),
    );
    await expect(
      inTenant(ids.orgA, (c) => visit(c, { invitationId: revoked })),
    ).rejects.toMatchObject({ code: '23514' });

    const invitation = await inTenant(ids.orgA, (c) => invite(c));
    const pass = await inTenant(ids.orgA, (c) => issuePass(c, invitation));
    await inTenant(ids.orgA, (c) =>
      c.query('UPDATE visitor_passes SET revoked_at = now() WHERE id = $1', [pass]),
    );
    await expect(
      inTenant(ids.orgA, (c) => visit(c, { invitationId: invitation, passId: pass })),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a backdated online admission, but stores paper and offline records as they happened', async () => {
    const invitation = await inTenant(ids.orgA, (c) =>
      invite(c, { from: hours(-5), until: hours(-3) }),
    );
    await expect(
      inTenant(ids.orgA, (c) => visit(c, { invitationId: invitation, arrivedAt: hours(-4) })),
    ).rejects.toMatchObject({ code: '23514' });
    await inTenant(ids.orgA, (c) =>
      visit(c, { invitationId: invitation, arrivedAt: hours(-4), source: 'PAPER' }),
    );
    // Even outside the window: the record must say what really happened at the gate.
    await inTenant(ids.orgA, (c) =>
      visit(c, { invitationId: invitation, arrivedAt: hours(-1), source: 'OFFLINE_SYNC' }),
    );
  });

  it('lets only one of two gates use the last entry at the same time', async () => {
    const invitation = await inTenant(ids.orgA, (c) => invite(c, { maxEntries: 1 }));
    const results = await Promise.allSettled([
      inTenant(ids.orgA, (c) => visit(c, { invitationId: invitation })),
      inTenant(ids.orgA, (c) => visit(c, { invitationId: invitation })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: '23514' },
    });
    const admitted = await inTenant(
      ids.orgA,
      async (c) =>
        (
          await c.query(
            `SELECT count(*)::int AS n FROM visits WHERE invitation_id = $1 AND decision = 'ADMITTED'`,
            [invitation],
          )
        ).rows[0].n,
    );
    expect(admitted).toBe(1);
  });
});

describe('visits are records, not drafts', () => {
  it('requires a reason for a denial and never lets a denied visitor depart', async () => {
    await expect(inTenant(ids.orgA, (c) => visit(c, { decision: 'DENIED' }))).rejects.toMatchObject(
      { code: '23514' },
    );
    await expect(
      inTenant(ids.orgA, (c) => visit(c, { denialReason: 'Admitted with a reason?' })),
    ).rejects.toMatchObject({ code: '23514' });
    const denied = await inTenant(ids.orgA, (c) =>
      visit(c, { decision: 'DENIED', denialReason: 'Not expected by the resident' }),
    );
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query(
          'UPDATE visits SET departed_at = now(), departure_recorded_by_user_id = $2 WHERE id = $1',
          [denied, ids.guard],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('records a walk-in departure once and refuses any other change', async () => {
    const walkIn = await inTenant(ids.orgA, (c) => visit(c, { unit: null }));
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query(`UPDATE visits SET visitor_name = 'Someone Else' WHERE id = $1`, [walkIn]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await inTenant(ids.orgA, (c) =>
      c.query(
        'UPDATE visits SET departed_at = now(), departure_recorded_by_user_id = $2 WHERE id = $1',
        [walkIn, ids.guard],
      ),
    );
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query('UPDATE visits SET departed_at = now() WHERE id = $1', [walkIn]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('cannot be deleted by the application', async () => {
    const id = await inTenant(ids.orgA, (c) => visit(c, { unit: null }));
    await expect(
      inTenant(ids.orgA, (c) => c.query('DELETE FROM visits WHERE id = $1', [id])),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('access events', () => {
  it('are append-only, even for a role that bypasses row-level security', async () => {
    const insert = (c: pg.PoolClient) =>
      c
        .query(
          `INSERT INTO access_events (id, organisation_id, property_id, type, occurred_at, actor_user_id, gate)
           VALUES ($1, $2, $3, 'PASS_REJECTED', now(), $4, 'Main gate') RETURNING id`,
          [randomUUID(), ids.orgA, ids.propA, ids.guard],
        )
        .then((r) => r.rows[0].id as string);
    const id = await inTenant(ids.orgA, insert);
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query(`UPDATE access_events SET gate = 'Back gate' WHERE id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: '42501' });

    // The application has no DELETE grant. The superuser sees every row (no RLS) and is still
    // stopped by the trigger, so the log cannot be rewritten even with full database access.
    await expect(
      inTenant(ids.orgA, (c) => c.query('DELETE FROM access_events WHERE id = $1', [id])),
    ).rejects.toMatchObject({ code: '42501' });
    const superuser = new pg.Pool({ connectionString: inject('superuserDatabaseUrl'), max: 1 });
    try {
      for (const sql of [
        'DELETE FROM access_events WHERE id = $1',
        `UPDATE access_events SET gate = 'Back gate' WHERE id = $1`,
      ]) {
        await expect(superuser.query(sql, [id])).rejects.toMatchObject({ code: '42501' });
      }
      const { rowCount } = await superuser.query('SELECT 1 FROM access_events WHERE id = $1', [id]);
      expect(rowCount).toBe(1);
    } finally {
      await superuser.end();
    }
  });
});

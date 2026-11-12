import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Staff operations (migration 20261121090000_staff_shifts): department names unique among active
 * ones; members of active departments, once at a time, removed once; shifts only for current
 * members, 15 minutes to 24 hours, never overlapping for a person (also under concurrency), moving
 * SCHEDULED -> STARTED -> ENDED with a handover note or SCHEDULED -> CANCELLED with a reason, times
 * set by the database; archiving waits for live shifts; tenant-isolated. Runs as veyra_app.
 */

let app: pg.Pool;

const ids = {
  org: randomUUID(),
  otherOrg: randomUUID(),
  prop: randomUUID(),
  guard: randomUUID(),
  guard2: randomUUID(),
  supervisor: randomUUID(),
};

async function inTenant<T>(org: string, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [org]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [ids.supervisor]);
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

async function department(c: pg.PoolClient, name: string) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO departments (id, organisation_id, property_id, name, updated_at) VALUES ($1, $2, $3, $4, now())`,
    [id, ids.org, ids.prop, name],
  );
  return id;
}

async function member(c: pg.PoolClient, dept: string, user: string) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO department_members (id, organisation_id, property_id, department_id, user_id) VALUES ($1, $2, $3, $4, $5)`,
    [id, ids.org, ids.prop, dept, user],
  );
  return id;
}

/** A shift `fromHours` to `toHours` from now. */
async function shift(
  c: pg.PoolClient,
  dept: string,
  user: string,
  fromHours: number,
  toHours: number,
) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO shifts (id, organisation_id, property_id, department_id, user_id, starts_at, ends_at,
       created_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6), now() + make_interval(mins => $7), $8, now())`,
    [
      id,
      ids.org,
      ids.prop,
      dept,
      user,
      Math.round(fromHours * 60),
      Math.round(toHours * 60),
      ids.supervisor,
    ],
  );
  return id;
}

const setShift = (
  c: pg.PoolClient,
  id: string,
  status: string,
  extra: Record<string, string> = {},
) =>
  c.query(`UPDATE shifts SET status = $2, handover_note = $3, cancel_reason = $4 WHERE id = $1`, [
    id,
    status,
    extra.handover ?? null,
    extra.reason ?? null,
  ]);

let security: string;

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 4 });
  for (const [id, name] of [
    [ids.guard, 'Guard'],
    [ids.guard2, 'Guard Two'],
    [ids.supervisor, 'Supervisor'],
  ] as const) {
    await app.query(
      `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, $3, now())`,
      [id, `staff-${id}@example.test`, name],
    );
  }
  for (const org of [ids.org, ids.otherOrg]) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `st-${org.slice(0, 8)}`],
      ),
    );
  }
  await asOrg(async (c) => {
    await c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Staff', 'ST', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    );
    security = await department(c, 'Security');
    await member(c, security, ids.guard);
    await member(c, security, ids.guard2);
  });
});

afterAll(async () => {
  await app?.end();
});

describe('departments', () => {
  it('have names unique among active ones and members added once at a time', async () => {
    await expect(asOrg((c) => department(c, 'security'))).rejects.toThrow(
      /departments_active_name_key/,
    );
    await expect(asOrg((c) => member(c, security, ids.guard))).rejects.toThrow(
      /department_members_current_key/,
    );
    const m = await asOrg((c) => member(c, security, ids.supervisor));
    await asOrg((c) =>
      c.query(`UPDATE department_members SET removed_at = now() WHERE id = $1`, [m]),
    );
    await expect(
      asOrg((c) => c.query(`UPDATE department_members SET removed_at = now() WHERE id = $1`, [m])),
    ).rejects.toThrow(/removed once/);
    // Removed, they can join again.
    await asOrg((c) => member(c, security, ids.supervisor));
  });

  it('are archived only without live shifts, then final', async () => {
    const d = await asOrg((c) => department(c, 'Housekeeping'));
    await asOrg((c) => member(c, d, ids.guard));
    const s = await asOrg((c) => shift(c, d, ids.guard, 100, 108));
    const archive = () =>
      asOrg((c) => c.query(`UPDATE departments SET status = 'ARCHIVED' WHERE id = $1`, [d]));
    await expect(archive()).rejects.toThrow(/cancel or finish the shifts/);
    await asOrg((c) => setShift(c, s, 'CANCELLED', { reason: 'Not needed' }));
    await archive();
    await expect(asOrg((c) => member(c, d, ids.guard2))).rejects.toThrow(/department is archived/);
    // Its name is free again.
    await asOrg((c) => department(c, 'Housekeeping'));
  });
});

describe('shifts', () => {
  it('go only to current members, for 15 minutes to 24 hours', async () => {
    const empty = await asOrg((c) => department(c, 'Gardening'));
    await expect(asOrg((c) => shift(c, empty, ids.supervisor, 200, 208))).rejects.toThrow(
      /members of the department/,
    );
    await expect(asOrg((c) => shift(c, security, ids.guard, 200, 200.1))).rejects.toThrow(
      /shifts_length/,
    );
    await expect(asOrg((c) => shift(c, security, ids.guard, 200, 225))).rejects.toThrow(
      /shifts_length/,
    );
  });

  it('never overlap for a person, even when booked at the same time', async () => {
    await asOrg((c) => shift(c, security, ids.guard, 300, 308));
    await expect(asOrg((c) => shift(c, security, ids.guard, 307, 315))).rejects.toThrow(
      /already has a shift then/,
    );
    // Back to back is fine; another person at the same time is fine.
    await asOrg((c) => shift(c, security, ids.guard, 308, 316));
    await asOrg((c) => shift(c, security, ids.guard2, 300, 308));

    const a = await app.connect();
    const b = await app.connect();
    try {
      for (const c of [a, b]) {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.organisation_id', $1, true)", [ids.org]);
      }
      await shift(a, security, ids.guard, 400, 408);
      const racing = shift(b, security, ids.guard, 404, 412);
      await a.query('COMMIT');
      await expect(racing).rejects.toThrow(/already has a shift then/);
    } finally {
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  });

  it("start, then end with a handover note; times are the database's; final states never change", async () => {
    const s = await asOrg((c) => shift(c, security, ids.guard2, -1, 7));
    await expect(asOrg((c) => setShift(c, s, 'ENDED', { handover: 'x' }))).rejects.toThrow(
      /cannot go from scheduled to ended/,
    );
    await asOrg((c) => setShift(c, s, 'STARTED'));
    await expect(asOrg((c) => setShift(c, s, 'ENDED'))).rejects.toThrow(/handover note/);
    await expect(
      asOrg((c) =>
        c.query(`UPDATE shifts SET ends_at = ends_at + interval '1 hour' WHERE id = $1`, [s]),
      ),
    ).rejects.toThrow(/only before it starts/);
    await asOrg((c) => setShift(c, s, 'ENDED', { handover: 'Gate 2 camera is offline.' }));
    await asOrg(async (c) => {
      const { rows } = await c.query(
        `SELECT started_at, ended_at, handover_note FROM shifts WHERE id = $1`,
        [s],
      );
      expect(rows[0].started_at).not.toBeNull();
      expect(rows[0].ended_at).not.toBeNull();
      expect(rows[0].handover_note).toBe('Gate 2 camera is offline.');
    });
    await expect(asOrg((c) => setShift(c, s, 'CANCELLED', { reason: 'x' }))).rejects.toThrow(
      /ended and no longer changes/,
    );
    const later = await asOrg((c) => shift(c, security, ids.guard2, 500, 508));
    await expect(asOrg((c) => setShift(c, later, 'CANCELLED'))).rejects.toThrow(/reason to cancel/);
  });
});

describe('isolation', () => {
  it('shows another organisation nothing and refuses deletes', async () => {
    const { rows } = await inTenant(ids.otherOrg, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM departments)::int AS d, (SELECT count(*) FROM department_members)::int AS m,
                (SELECT count(*) FROM shifts)::int AS s`,
      ),
    );
    expect(rows[0]).toEqual({ d: 0, m: 0, s: 0 });
    await expect(asOrg((c) => c.query(`DELETE FROM shifts`))).rejects.toThrow(/permission denied/);
  });
});

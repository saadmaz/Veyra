import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Governance (migration 20261127090000_governance): one seat per person and one chair at a time,
 * a term ended once; dissolved committees take no seats or meetings; meetings are held not before
 * their time or cancelled with a reason, the agenda fixed once held, minutes approved once by a
 * person and then final; resolutions numbered per property, only at a held meeting before its
 * minutes are approved, never changed; tenant-isolated.
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
    [ids.manager, `gov-${ids.manager}@example.test`],
  );
  for (const org of [ids.org, ids.otherOrg]) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `gv-${org.slice(0, 8)}`],
      ),
    );
  }
  await asOrg((c) =>
    c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Governance', 'GV', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
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
    `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, 'Member', now())`,
    [id, `gov-${id}@example.test`],
  );
  return id;
}

async function committee(c: pg.PoolClient, name = `Board ${randomUUID().slice(0, 6)}`) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO committees (id, organisation_id, property_id, name, updated_at) VALUES ($1, $2, $3, $4, now())`,
    [id, ids.org, ids.prop, name],
  );
  return id;
}

const seat = (
  committeeId: string,
  userId: string,
  position: string,
  from: string,
  to: string | null = null,
) =>
  asOrg((c) =>
    c.query(
      `INSERT INTO committee_members (id, organisation_id, property_id, committee_id, user_id, position, term_start, term_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [randomUUID(), ids.org, ids.prop, committeeId, userId, position, from, to],
    ),
  );

async function meeting(
  c: pg.PoolClient,
  committeeId: string,
  at = new Date(Date.now() - 3_600_000),
) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO meetings (id, organisation_id, property_id, committee_id, title, scheduled_at, updated_at)
     VALUES ($1, $2, $3, $4, 'Monthly meeting', $5, now())`,
    [id, ids.org, ids.prop, committeeId, at],
  );
  return id;
}

const resolution = (meetingId: string) =>
  asOrg((c) =>
    c.query(
      `INSERT INTO resolutions (id, organisation_id, property_id, meeting_id, title, text, outcome, votes_for, recorded_by_user_id)
       VALUES ($1, $2, $3, $4, 'Repaint the lobby', 'Approved within the budget.', 'PASSED', 5, $5)
       RETURNING resolution_number`,
      [randomUUID(), ids.org, ids.prop, meetingId, ids.manager],
    ),
  );

describe('governance', () => {
  it('seat one person once at a time, one chair at a time, and end a term once', async () => {
    const board = await asOrg((c) => committee(c));
    const [a, b] = [await user(), await user()];
    const first = (await seat(board, a, 'CHAIR', '2026-01-01')).rows[0].id;
    await expect(seat(board, a, 'MEMBER', '2026-06-01')).rejects.toThrow(
      /committee_members_one_seat/,
    );
    await expect(seat(board, b, 'CHAIR', '2026-06-01')).rejects.toThrow(
      /committee_members_one_chair/,
    );
    await asOrg((c) =>
      c.query(`UPDATE committee_members SET term_end = '2026-05-31' WHERE id = $1`, [first]),
    );
    await seat(board, b, 'CHAIR', '2026-06-01');
    await expect(
      asOrg((c) =>
        c.query(`UPDATE committee_members SET term_end = '2026-12-31' WHERE id = $1`, [first]),
      ),
    ).rejects.toThrow(/once/);
    await expect(seat(board, b, 'MEMBER', '2025-01-01', '2024-01-01')).rejects.toThrow(
      /committee_members_term/,
    );
  });

  it('take no seats or meetings once dissolved, and keep active names unique', async () => {
    const name = `Garden ${randomUUID().slice(0, 6)}`;
    const garden = await asOrg((c) => committee(c, name));
    await expect(asOrg((c) => committee(c, name.toUpperCase()))).rejects.toThrow(
      /committees_active_name/,
    );
    await asOrg((c) =>
      c.query(`UPDATE committees SET status = 'DISSOLVED' WHERE id = $1`, [garden]),
    );
    await expect(seat(garden, await user(), 'MEMBER', '2026-01-01')).rejects.toThrow(/dissolved/);
    await expect(asOrg((c) => meeting(c, garden))).rejects.toThrow(/dissolved/);
    await asOrg((c) => committee(c, name));
  });

  it('hold meetings not before their time, fix the agenda, approve minutes once', async () => {
    const board = await asOrg((c) => committee(c));
    const later = await asOrg((c) => meeting(c, board, new Date(Date.now() + 7 * 86_400_000)));
    await expect(
      asOrg((c) => c.query(`UPDATE meetings SET status = 'HELD' WHERE id = $1`, [later])),
    ).rejects.toThrow(/before its time/);
    await expect(
      asOrg((c) => c.query(`UPDATE meetings SET status = 'CANCELLED' WHERE id = $1`, [later])),
    ).rejects.toThrow(/meetings_text/);
    await asOrg((c) =>
      c.query(
        `UPDATE meetings SET status = 'CANCELLED', cancel_reason = 'No quorum' WHERE id = $1`,
        [later],
      ),
    );
    const m = await asOrg((c) => meeting(c, board));
    const agenda = (pos: number) =>
      asOrg((c) =>
        c.query(
          `INSERT INTO meeting_agenda_items (id, organisation_id, property_id, meeting_id, position, title)
           VALUES ($1, $2, $3, $4, $5, 'Budget')`,
          [randomUUID(), ids.org, ids.prop, m, pos],
        ),
      );
    await agenda(1);
    await expect(resolution(m)).rejects.toThrow(/held meeting/);
    await asOrg((c) => c.query(`UPDATE meetings SET status = 'HELD' WHERE id = $1`, [m]));
    await expect(agenda(2)).rejects.toThrow(/agenda is fixed/);
    const n1 = Number((await resolution(m)).rows[0].resolution_number);
    const n2 = Number((await resolution(m)).rows[0].resolution_number);
    expect(n2).toBe(n1 + 1);
    await expect(
      asOrg((c) =>
        c.query(
          `UPDATE meetings SET minutes_approved_at = now(), minutes_approved_by_user_id = $2 WHERE id = $1`,
          [m, ids.manager],
        ),
      ),
    ).rejects.toThrow(/meetings_text/);
    await asOrg((c) =>
      c.query(`UPDATE meetings SET minutes = 'Present: all members.' WHERE id = $1`, [m]),
    );
    await asOrg((c) =>
      c.query(
        `UPDATE meetings SET minutes_approved_at = now(), minutes_approved_by_user_id = $2 WHERE id = $1`,
        [m, ids.manager],
      ),
    );
    await expect(
      asOrg((c) => c.query(`UPDATE meetings SET minutes = 'Changed' WHERE id = $1`, [m])),
    ).rejects.toThrow(/final/);
    await expect(resolution(m)).rejects.toThrow(/before its minutes are approved/);
  });

  it('never change resolutions, and are invisible to another organisation', async () => {
    await expect(asOrg((c) => c.query(`UPDATE resolutions SET title = 'x'`))).rejects.toThrow(
      /permission denied/,
    );
    const { rows } = await inTenant(ids.otherOrg, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM committees)::int AS c, (SELECT count(*) FROM meetings)::int AS m,
                (SELECT count(*) FROM resolutions)::int AS r`,
      ),
    );
    expect(rows[0]).toEqual({ c: 0, m: 0, r: 0 });
    await expect(asOrg((c) => c.query(`DELETE FROM meetings`))).rejects.toThrow(
      /permission denied/,
    );
  });
});

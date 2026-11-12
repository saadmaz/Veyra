import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Checklists (migration 20261122090000_checklists): templates hold 1-50 trimmed checks and are
 * archived for good; runs start open from an active template, with a live shift of the same
 * person if any; checks are answered only while open (a failed check needs a note, answer times
 * set by the database); a run is submitted only when every check is answered, verified by
 * someone other than the assignee or returned with a note, and cancelled with a reason; final
 * states never change; tenant-isolated. Runs as veyra_app.
 */

let app: pg.Pool;

const ids = {
  org: randomUUID(),
  otherOrg: randomUUID(),
  prop: randomUUID(),
  guard: randomUUID(),
  supervisor: randomUUID(),
  dept: randomUUID(),
};

async function inTenant<T>(
  org: string,
  work: (c: pg.PoolClient) => Promise<T>,
  user: string = ids.supervisor,
): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [org]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [user]);
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
const asSupervisor = <T>(work: (c: pg.PoolClient) => Promise<T>) => inTenant(ids.org, work);
const asGuard = <T>(work: (c: pg.PoolClient) => Promise<T>) => inTenant(ids.org, work, ids.guard);

async function template(c: pg.PoolClient, items: string[]) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO checklist_templates (id, organisation_id, property_id, department_id, title, items,
       created_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, 'Night patrol', $5, $6, now())`,
    [id, ids.org, ids.prop, ids.dept, items, ids.supervisor],
  );
  return id;
}

/** A run for the guard with its checks copied, as the API does. */
async function runOf(
  c: pg.PoolClient,
  templateId: string,
  items: string[],
  shift: string | null = null,
) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO checklist_runs (id, organisation_id, property_id, template_id, title, assigned_to_user_id,
       shift_id, due_on, created_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, 'Night patrol', $5, $6, '2026-12-01', $7, now())`,
    [id, ids.org, ids.prop, templateId, ids.guard, shift, ids.supervisor],
  );
  for (const [i, text] of items.entries()) {
    await c.query(
      `INSERT INTO checklist_run_items (id, organisation_id, property_id, run_id, position, text)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), ids.org, ids.prop, id, i + 1, text],
    );
  }
  return id;
}

const answer = (
  c: pg.PoolClient,
  run: string,
  position: number,
  result: string,
  note: string | null = null,
) =>
  c.query(
    `UPDATE checklist_run_items SET result = $3, note = $4 WHERE run_id = $1 AND position = $2`,
    [run, position, result, note],
  );

const setRun = (c: pg.PoolClient, id: string, status: string, note: string | null = null) =>
  c.query(`UPDATE checklist_runs SET status = $2, status_note = $3 WHERE id = $1`, [
    id,
    status,
    note,
  ]);

const CHECKS = ['Gate 1 locked', 'Fire exits clear'];

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 4 });
  for (const [id, name] of [
    [ids.guard, 'Guard'],
    [ids.supervisor, 'Supervisor'],
  ] as const) {
    await app.query(
      `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, $3, now())`,
      [id, `check-${id}@example.test`, name],
    );
  }
  for (const org of [ids.org, ids.otherOrg]) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `ck-${org.slice(0, 8)}`],
      ),
    );
  }
  await asSupervisor(async (c) => {
    await c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Checks', 'CK', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    );
    await c.query(
      `INSERT INTO departments (id, organisation_id, property_id, name, updated_at) VALUES ($1, $2, $3, 'Security', now())`,
      [ids.dept, ids.org, ids.prop],
    );
    await c.query(
      `INSERT INTO department_members (id, organisation_id, property_id, department_id, user_id) VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), ids.org, ids.prop, ids.dept, ids.guard],
    );
  });
});

afterAll(async () => {
  await app?.end();
});

describe('templates', () => {
  it('hold 1 to 50 trimmed checks and are archived for good', async () => {
    await expect(asSupervisor((c) => template(c, []))).rejects.toThrow(/checklist_templates_text/);
    await expect(asSupervisor((c) => template(c, [' padded ']))).rejects.toThrow(
      /checklist_templates_items/,
    );
    const t = await asSupervisor((c) => template(c, CHECKS));
    await asSupervisor((c) =>
      c.query(`UPDATE checklist_templates SET status = 'ARCHIVED' WHERE id = $1`, [t]),
    );
    await expect(
      asSupervisor((c) => c.query(`UPDATE checklist_templates SET title = 'x' WHERE id = $1`, [t])),
    ).rejects.toThrow(/archived and no longer changes/);
    await expect(asSupervisor((c) => runOf(c, t, CHECKS))).rejects.toThrow(/template is archived/);
  });
});

describe('runs', () => {
  it('are answered while open, submitted when complete, and verified by someone else', async () => {
    const t = await asSupervisor((c) => template(c, CHECKS));
    const run = await asSupervisor((c) => runOf(c, t, CHECKS));
    await expect(asGuard((c) => answer(c, run, 2, 'FAIL'))).rejects.toThrow(
      /checklist_run_items_answer/,
    );
    await asGuard((c) => answer(c, run, 1, 'PASS'));
    await expect(asGuard((c) => setRun(c, run, 'SUBMITTED'))).rejects.toThrow(/answer every check/);
    await asGuard((c) => answer(c, run, 2, 'FAIL', 'Exit B blocked by boxes'));
    await asGuard((c) => setRun(c, run, 'SUBMITTED'));
    await expect(asGuard((c) => answer(c, run, 1, 'NOT_APPLICABLE'))).rejects.toThrow(
      /only while the checklist is open/,
    );
    // The person who did it cannot verify it.
    await expect(asGuard((c) => setRun(c, run, 'VERIFIED'))).rejects.toThrow(/someone other than/);
    await expect(asSupervisor((c) => setRun(c, run, 'OPEN'))).rejects.toThrow(
      /why the checklist is returned/,
    );
    await asSupervisor((c) => setRun(c, run, 'OPEN', 'Photograph exit B'));
    await asGuard((c) => setRun(c, run, 'SUBMITTED'));
    await asSupervisor((c) => setRun(c, run, 'VERIFIED'));
    await asSupervisor(async (c) => {
      const { rows } = await c.query(
        `SELECT verified_by_user_id, verified_at, submitted_at, status_note FROM checklist_runs WHERE id = $1`,
        [run],
      );
      expect(rows[0]).toMatchObject({ verified_by_user_id: ids.supervisor, status_note: null });
      expect(rows[0].verified_at).not.toBeNull();
      const items = await c.query(
        `SELECT answered_by_user_id, answered_at FROM checklist_run_items WHERE run_id = $1 ORDER BY position`,
        [run],
      );
      expect(items.rows.every((r) => r.answered_by_user_id === ids.guard && r.answered_at)).toBe(
        true,
      );
    });
    await expect(asSupervisor((c) => setRun(c, run, 'CANCELLED', 'x'))).rejects.toThrow(
      /verified and no longer changes/,
    );
  });

  it('go only with a live shift of the same person, keep their checks, and cancel with a reason', async () => {
    const t = await asSupervisor((c) => template(c, CHECKS));
    const otherShift = randomUUID();
    await asSupervisor((c) =>
      c.query(
        `INSERT INTO department_members (id, organisation_id, property_id, department_id, user_id) VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), ids.org, ids.prop, ids.dept, ids.supervisor],
      ),
    );
    await asSupervisor((c) =>
      c.query(
        `INSERT INTO shifts (id, organisation_id, property_id, department_id, user_id, starts_at, ends_at,
           created_by_user_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '1 day', now() + interval '1 day 8 hours', $5, now())`,
        [otherShift, ids.org, ids.prop, ids.dept, ids.supervisor],
      ),
    );
    await expect(asSupervisor((c) => runOf(c, t, CHECKS, otherShift))).rejects.toThrow(
      /same person/,
    );
    const run = await asSupervisor((c) => runOf(c, t, CHECKS));
    await expect(
      asGuard((c) =>
        c.query(`UPDATE checklist_run_items SET text = 'Easier check' WHERE run_id = $1`, [run]),
      ),
    ).rejects.toThrow(/keeps its wording/);
    await expect(asSupervisor((c) => setRun(c, run, 'CANCELLED'))).rejects.toThrow(
      /reason to cancel/,
    );
    await asSupervisor((c) => setRun(c, run, 'CANCELLED', 'Patrol replaced by cameras'));
  });
});

describe('isolation', () => {
  it('shows another organisation nothing and refuses deletes', async () => {
    const { rows } = await inTenant(ids.otherOrg, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM checklist_templates)::int AS t, (SELECT count(*) FROM checklist_runs)::int AS r,
                (SELECT count(*) FROM checklist_run_items)::int AS i`,
      ),
    );
    expect(rows[0]).toEqual({ t: 0, r: 0, i: 0 });
    await expect(asSupervisor((c) => c.query(`DELETE FROM checklist_runs`))).rejects.toThrow(
      /permission denied/,
    );
  });
});

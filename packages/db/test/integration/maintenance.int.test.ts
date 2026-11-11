import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Maintenance (migration 20261114090000_maintenance): requests and work orders are numbered per
 * property, get SLA due times from the property's targets, move only along the allowed status
 * transitions (with the reasons they need), and a request is resolved only once its work is
 * done; what was reported never changes; every status, assignee and priority change is logged by
 * the database with its actor; history is append-only even for the superuser; costs are in the
 * property currency and corrected only by voiding; everything is tenant-isolated. Runs as
 * veyra_app unless stated.
 */

let app: pg.Pool;
let superuser: pg.Pool;

async function inTenant<T>(
  organisationId: string,
  work: (c: pg.PoolClient) => Promise<T>,
  userId: string | null = ids.manager,
): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [organisationId]);
    if (userId) await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
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
  otherOrg: randomUUID(),
  prop: randomUUID(),
  prop2: randomUUID(),
  unit: randomUUID(),
  archivedUnit: randomUUID(),
  gym: randomUUID(),
  resident: randomUUID(),
  manager: randomUUID(),
  tech: randomUUID(),
};

interface RequestInput {
  prop?: string;
  unit?: string | null;
  area?: string | null;
  priority?: string;
  title?: string;
}

async function request(c: pg.PoolClient, input: RequestInput = {}) {
  const id = randomUUID();
  const { rows } = await c.query(
    `INSERT INTO maintenance_requests (id, organisation_id, property_id, unit_id, common_area_id, category, priority,
       title, description, submitted_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'PLUMBING', $6, $7, 'Water under the sink', $8, now())
     RETURNING request_number, response_due_at, resolution_due_at, created_at`,
    [
      id,
      ids.org,
      input.prop ?? ids.prop,
      input.unit === undefined ? ids.unit : input.unit,
      input.area ?? null,
      input.priority ?? 'MEDIUM',
      input.title ?? 'Leaking sink',
      ids.resident,
    ],
  );
  return { id, ...rows[0] };
}

const setRequest = (c: pg.PoolClient, id: string, status: string, note: string | null = null) =>
  c.query(`UPDATE maintenance_requests SET status = $2, status_note = $3 WHERE id = $1`, [
    id,
    status,
    note,
  ]);

async function workOrder(
  c: pg.PoolClient,
  input: {
    request?: string | null;
    unit?: string | null;
    area?: string | null;
    assignee?: string;
  } = {},
) {
  const id = randomUUID();
  const { rows } = await c.query(
    `INSERT INTO work_orders (id, organisation_id, property_id, request_id, unit_id, common_area_id, category,
       priority, title, status, assigned_to_user_id, created_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'PLUMBING', 'MEDIUM', 'Fix the trap', $7, $8, $9, now())
     RETURNING work_order_number`,
    [
      id,
      ids.org,
      ids.prop,
      input.request ?? null,
      input.unit === undefined ? ids.unit : input.unit,
      input.area ?? null,
      input.assignee ? 'ASSIGNED' : 'OPEN',
      input.assignee ?? null,
      ids.manager,
    ],
  );
  return { id, number: Number(rows[0].work_order_number) };
}

const setWork = (
  c: pg.PoolClient,
  id: string,
  status: string,
  note: string | null = null,
  assignee?: string | null,
) =>
  assignee === undefined
    ? c.query(`UPDATE work_orders SET status = $2, status_note = $3 WHERE id = $1`, [
        id,
        status,
        note,
      ])
    : c.query(
        `UPDATE work_orders SET status = $2, status_note = $3, assigned_to_user_id = $4 WHERE id = $1`,
        [id, status, note, assignee],
      );

/** Takes a fresh request through acceptance and completed work to RESOLVED. */
async function resolved(c: pg.PoolClient): Promise<string> {
  const r = await request(c);
  await setRequest(c, r.id, 'ACCEPTED');
  const w = await workOrder(c, { request: r.id, assignee: ids.tech });
  await setWork(c, w.id, 'IN_PROGRESS');
  await setWork(c, w.id, 'COMPLETED', 'Replaced the washer');
  await setRequest(c, r.id, 'RESOLVED');
  return r.id;
}

const events = (c: pg.PoolClient, column: 'request_id' | 'work_order_id', id: string) =>
  c
    .query(
      `SELECT type, visibility, from_value, to_value, body, actor_user_id FROM maintenance_events
        WHERE ${column} = $1 ORDER BY sequence`,
      [id],
    )
    .then((r) => r.rows);

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 4 });
  superuser = new pg.Pool({ connectionString: inject('superuserDatabaseUrl'), max: 1 });
  for (const [id, name] of [
    [ids.resident, 'Resident'],
    [ids.manager, 'Manager'],
    [ids.tech, 'Technician'],
  ] as const) {
    await app.query(
      `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, $3, now())`,
      [id, `maint-${id}@example.test`, name],
    );
  }
  for (const org of [ids.org, ids.otherOrg]) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `mt-${org.slice(0, 8)}`],
      ),
    );
  }
  await inTenant(ids.org, async (c) => {
    for (const [id, code] of [
      [ids.prop, 'MT'],
      [ids.prop2, 'MU'],
    ] as const) {
      await c.query(
        `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
         VALUES ($1, $2, $3, $3, 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
        [id, ids.org, code],
      );
    }
    for (const [id, number, status] of [
      [ids.unit, 'M1', 'ACTIVE'],
      [ids.archivedUnit, 'M2', 'ARCHIVED'],
    ] as const) {
      await c.query(
        `INSERT INTO units (id, organisation_id, property_id, number, type, status, archived_at, updated_at)
         VALUES ($1, $2, $3, $4, 'APARTMENT', $5, $6, now())`,
        [id, ids.org, ids.prop, number, status, status === 'ARCHIVED' ? new Date() : null],
      );
    }
    await c.query(
      `INSERT INTO common_areas (id, organisation_id, property_id, name, type, updated_at)
       VALUES ($1, $2, $3, 'Gym', 'GYM', now())`,
      [ids.gym, ids.org, ids.prop],
    );
    await c.query(
      `INSERT INTO maintenance_sla_targets (id, organisation_id, property_id, priority, response_minutes,
         resolution_minutes, updated_at)
       VALUES ($1, $2, $3, 'URGENT', 60, 240, now()), ($4, $2, $3, 'MEDIUM', 1440, 4320, now())`,
      [randomUUID(), ids.org, ids.prop, randomUUID()],
    );
  });
});

afterAll(async () => {
  await app?.end();
  await superuser?.end();
});

describe('requests', () => {
  it('are numbered per property and get due times from the property targets', async () => {
    await inTenant(ids.org, async (c) => {
      const a = await request(c, { priority: 'URGENT' });
      const b = await request(c);
      expect(Number(b.request_number)).toBe(Number(a.request_number) + 1);
      const minutes = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 60_000;
      expect(minutes(a.created_at, a.response_due_at)).toBe(60);
      expect(minutes(a.created_at, a.resolution_due_at)).toBe(240);
      // No target for LOW: no due times.
      const low = await request(c, { priority: 'LOW' });
      expect(low.response_due_at).toBeNull();
      // Another property counts from 1 (it has no units: a common area is not needed either).
    });
  });

  it('recomputes the due times when the priority changes, and logs it for the requester', async () => {
    await inTenant(ids.org, async (c) => {
      const r = await request(c, { priority: 'LOW' });
      await c.query(`UPDATE maintenance_requests SET priority = 'URGENT' WHERE id = $1`, [r.id]);
      const { rows } = await c.query(
        `SELECT response_due_at, created_at FROM maintenance_requests WHERE id = $1`,
        [r.id],
      );
      expect((rows[0].response_due_at.getTime() - rows[0].created_at.getTime()) / 60_000).toBe(60);
      const log = await events(c, 'request_id', r.id);
      expect(log.map((e) => [e.type, e.visibility, e.from_value, e.to_value])).toEqual([
        ['STATUS_CHANGED', 'RESIDENT', null, 'SUBMITTED'],
        ['PRIORITY_CHANGED', 'RESIDENT', 'LOW', 'URGENT'],
      ]);
    });
  });

  it('need exactly one place, an active one, and trimmed text', async () => {
    await expect(inTenant(ids.org, (c) => request(c, { unit: null }))).rejects.toThrow(
      /one_location/,
    );
    await expect(inTenant(ids.org, (c) => request(c, { area: ids.gym }))).rejects.toThrow(
      /one_location/,
    );
    await expect(inTenant(ids.org, (c) => request(c, { unit: ids.archivedUnit }))).rejects.toThrow(
      /unit is archived/,
    );
    await expect(inTenant(ids.org, (c) => request(c, { title: ' Leak ' }))).rejects.toThrow(
      /maintenance_requests_text/,
    );
    await inTenant(ids.org, (c) => request(c, { unit: null, area: ids.gym }));
  });

  it('never change what was reported', async () => {
    const id = await inTenant(ids.org, async (c) => (await request(c)).id);
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`UPDATE maintenance_requests SET description = 'Edited' WHERE id = $1`, [id]),
      ),
    ).rejects.toThrow(/never changes/);
  });

  it('own their timestamps: a client cannot backdate or pre-accept', async () => {
    await inTenant(ids.org, async (c) => {
      const r = await request(c);
      await c.query(
        `UPDATE maintenance_requests SET accepted_at = '2020-01-01', reopen_count = 5,
                response_due_at = '2099-01-01' WHERE id = $1`,
        [r.id],
      );
      const { rows } = await c.query(
        `SELECT accepted_at, reopen_count, response_due_at FROM maintenance_requests WHERE id = $1`,
        [r.id],
      );
      expect(rows[0]).toMatchObject({ accepted_at: null, reopen_count: 0 });
      expect(rows[0].response_due_at).toEqual(r.response_due_at);
    });
  });

  it('move only along the allowed transitions, with reasons where needed', async () => {
    const id = await inTenant(ids.org, async (c) => (await request(c)).id);
    for (const status of ['RESOLVED', 'CLOSED']) {
      await expect(inTenant(ids.org, (c) => setRequest(c, id, status))).rejects.toThrow(
        /cannot go from submitted/,
      );
    }
    await expect(inTenant(ids.org, (c) => setRequest(c, id, 'REJECTED'))).rejects.toThrow(
      /reason to reject/,
    );
    await inTenant(ids.org, (c) => setRequest(c, id, 'REJECTED', 'Owner responsibility'));
    await expect(inTenant(ids.org, (c) => setRequest(c, id, 'SUBMITTED'))).rejects.toThrow(
      /rejected and no longer changes/,
    );
    const log = await inTenant(ids.org, (c) => events(c, 'request_id', id));
    expect(log.at(-1)).toMatchObject({
      type: 'STATUS_CHANGED',
      to_value: 'REJECTED',
      body: 'Owner responsibility',
      actor_user_id: ids.manager,
    });
  });

  it('are accepted by the current user and resolved only when the work is done', async () => {
    await inTenant(ids.org, async (c) => {
      const r = await request(c);
      await setRequest(c, r.id, 'ACCEPTED');
      const { rows } = await c.query(
        `SELECT accepted_by_user_id, accepted_at FROM maintenance_requests WHERE id = $1`,
        [r.id],
      );
      expect(rows[0].accepted_by_user_id).toBe(ids.manager);
      expect(rows[0].accepted_at).not.toBeNull();
    });
    // No work at all, then work still open: not resolved.
    const pending = await inTenant(ids.org, async (c) => {
      const r = await request(c);
      await setRequest(c, r.id, 'ACCEPTED');
      return r.id;
    });
    await expect(inTenant(ids.org, (c) => setRequest(c, pending, 'RESOLVED'))).rejects.toThrow(
      /once its work is completed/,
    );
    await inTenant(ids.org, async (c) => {
      const done = await workOrder(c, { request: pending, assignee: ids.tech });
      await setWork(c, done.id, 'IN_PROGRESS');
      await setWork(c, done.id, 'COMPLETED', 'Fixed');
      await workOrder(c, { request: pending });
    });
    await expect(inTenant(ids.org, (c) => setRequest(c, pending, 'RESOLVED'))).rejects.toThrow(
      /once its work is completed/,
    );
    await expect(
      inTenant(ids.org, (c) => setRequest(c, pending, 'CANCELLED', 'No longer needed')),
    ).rejects.toThrow(/cancel the open work orders/);
  });

  it('are reopened with a reason, then confirmed closed', async () => {
    const id = await inTenant(ids.org, resolved);
    await expect(inTenant(ids.org, (c) => setRequest(c, id, 'ACCEPTED'))).rejects.toThrow(
      /reason to reopen/,
    );
    await inTenant(ids.org, (c) => setRequest(c, id, 'ACCEPTED', 'Still dripping'), ids.resident);
    await inTenant(ids.org, async (c) => {
      const { rows } = await c.query(
        `SELECT reopen_count, resolved_at FROM maintenance_requests WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({ reopen_count: 1, resolved_at: null });
      // The first work order is completed; new work is needed to resolve again.
      const w = await workOrder(c, { request: id, assignee: ids.tech });
      await setWork(c, w.id, 'IN_PROGRESS');
      await setWork(c, w.id, 'COMPLETED', 'Replaced the tap');
      await setRequest(c, id, 'RESOLVED');
    });
    await inTenant(ids.org, (c) => setRequest(c, id, 'CLOSED'), ids.resident);
    const log = await inTenant(ids.org, (c) => events(c, 'request_id', id));
    const statuses = log
      .filter((e) => e.type === 'STATUS_CHANGED' && e.visibility === 'RESIDENT')
      .map((e) => e.to_value);
    expect(statuses).toEqual([
      'SUBMITTED',
      'ACCEPTED',
      'RESOLVED',
      'ACCEPTED',
      'RESOLVED',
      'CLOSED',
    ]);
    expect(log.find((e) => e.body === 'Still dripping')?.actor_user_id).toBe(ids.resident);
  });
});

describe('work orders', () => {
  it('are numbered per property and raised only for accepted requests, where the request is', async () => {
    await inTenant(ids.org, async (c) => {
      const a = await workOrder(c);
      const b = await workOrder(c, { unit: null, area: ids.gym });
      expect(b.number).toBe(a.number + 1);
    });
    const submitted = await inTenant(ids.org, async (c) => (await request(c)).id);
    await expect(inTenant(ids.org, (c) => workOrder(c, { request: submitted }))).rejects.toThrow(
      /accepted requests only/,
    );
    const accepted = await inTenant(ids.org, async (c) => {
      const r = await request(c);
      await setRequest(c, r.id, 'ACCEPTED');
      return r.id;
    });
    await expect(
      inTenant(ids.org, (c) => workOrder(c, { request: accepted, unit: null, area: ids.gym })),
    ).rejects.toThrow(/where its request is/);
  });

  it('need someone on assigned work and a reason to pause, complete or cancel', async () => {
    const id = await inTenant(ids.org, async (c) => (await workOrder(c)).id);
    await expect(inTenant(ids.org, (c) => setWork(c, id, 'ASSIGNED'))).rejects.toThrow(
      /work_orders_assignee/,
    );
    await expect(inTenant(ids.org, (c) => setWork(c, id, 'IN_PROGRESS'))).rejects.toThrow(
      /cannot go from open to in_progress/,
    );
    await inTenant(ids.org, (c) => setWork(c, id, 'ASSIGNED', null, ids.tech));
    await inTenant(ids.org, (c) => setWork(c, id, 'IN_PROGRESS'), ids.tech);
    await expect(inTenant(ids.org, (c) => setWork(c, id, 'ON_HOLD'))).rejects.toThrow(
      /why the work is on hold/,
    );
    await inTenant(ids.org, (c) => setWork(c, id, 'ON_HOLD', 'Waiting for a part'), ids.tech);
    await inTenant(ids.org, (c) => setWork(c, id, 'IN_PROGRESS'), ids.tech);
    await expect(inTenant(ids.org, (c) => setWork(c, id, 'COMPLETED'))).rejects.toThrow(
      /complete \(what was done\)/,
    );
    await inTenant(ids.org, (c) => setWork(c, id, 'COMPLETED', 'Part fitted'), ids.tech);
    await expect(inTenant(ids.org, (c) => setWork(c, id, 'IN_PROGRESS'))).rejects.toThrow(
      /completed and no longer changes/,
    );
    const log = await inTenant(ids.org, (c) => events(c, 'work_order_id', id));
    expect(log.map((e) => [e.type, e.to_value])).toEqual([
      ['STATUS_CHANGED', 'OPEN'],
      ['STATUS_CHANGED', 'ASSIGNED'],
      ['ASSIGNEE_CHANGED', ids.tech],
      ['STATUS_CHANGED', 'IN_PROGRESS'],
      ['STATUS_CHANGED', 'ON_HOLD'],
      ['STATUS_CHANGED', 'IN_PROGRESS'],
      ['STATUS_CHANGED', 'COMPLETED'],
    ]);
    expect(log.every((e) => e.visibility === 'INTERNAL')).toBe(true);
    expect(log.at(-1)).toMatchObject({ body: 'Part fitted', actor_user_id: ids.tech });
    const { rows } = await inTenant(ids.org, (c) =>
      c.query(`SELECT started_at, completed_at FROM work_orders WHERE id = $1`, [id]),
    );
    expect(rows[0].started_at).not.toBeNull();
    expect(rows[0].completed_at).not.toBeNull();
  });

  it('cannot be assigned without moving to assigned, nor moved to another request', async () => {
    const id = await inTenant(ids.org, async (c) => (await workOrder(c)).id);
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`UPDATE work_orders SET assigned_to_user_id = $2 WHERE id = $1`, [id, ids.tech]),
      ),
    ).rejects.toThrow(/moves it to assigned/);
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`UPDATE work_orders SET unit_id = NULL, common_area_id = $2 WHERE id = $1`, [
          id,
          ids.gym,
        ]),
      ),
    ).rejects.toThrow(/cannot move/);
  });
});

describe('costs', () => {
  it('are in the property currency, never on cancelled work, and voided once instead of edited', async () => {
    const work = await inTenant(ids.org, async (c) => (await workOrder(c)).id);
    const cost = (c: pg.PoolClient, currency = 'PKR', on = work) => {
      const id = randomUUID();
      return c
        .query(
          `INSERT INTO work_order_costs (id, organisation_id, property_id, work_order_id, kind, description,
             amount_minor, currency, recorded_by_user_id)
           VALUES ($1, $2, $3, $4, 'MATERIAL', 'Washer', 15000, $5, $6)`,
          [id, ids.org, ids.prop, on, currency, ids.manager],
        )
        .then(() => id);
    };
    await expect(inTenant(ids.org, (c) => cost(c, 'USD'))).rejects.toThrow(/currency/);
    const id = await inTenant(ids.org, (c) => cost(c));
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`UPDATE work_order_costs SET amount_minor = 1 WHERE id = $1`, [id]),
      ),
    ).rejects.toThrow(/never edited/);
    await inTenant(ids.org, (c) =>
      c.query(
        `UPDATE work_order_costs SET voided_at = now(), voided_by_user_id = $2, void_reason = 'Wrong part'
          WHERE id = $1`,
        [id, ids.manager],
      ),
    );
    await expect(
      inTenant(ids.org, (c) =>
        c.query(
          `UPDATE work_order_costs SET voided_at = now(), voided_by_user_id = $2, void_reason = 'Again'
            WHERE id = $1`,
          [id, ids.manager],
        ),
      ),
    ).rejects.toThrow(/never edited/);
    await inTenant(ids.org, (c) => setWork(c, work, 'CANCELLED', 'Duplicate'));
    await expect(inTenant(ids.org, (c) => cost(c))).rejects.toThrow(/cancelled work/);
  });
});

describe('history', () => {
  it('takes notes from the application but status changes only from the database', async () => {
    const r = await inTenant(ids.org, (c) => request(c));
    await inTenant(ids.org, (c) =>
      c.query(
        `INSERT INTO maintenance_events (id, organisation_id, property_id, request_id, type, visibility, body, actor_user_id)
         VALUES ($1, $2, $3, $4, 'NOTE', 'RESIDENT', 'A plumber comes tomorrow', $5)`,
        [randomUUID(), ids.org, ids.prop, r.id, ids.manager],
      ),
    );
    await expect(
      inTenant(ids.org, (c) =>
        c.query(
          `INSERT INTO maintenance_events (id, organisation_id, property_id, request_id, type, visibility, to_value)
           VALUES ($1, $2, $3, $4, 'STATUS_CHANGED', 'RESIDENT', 'CLOSED')`,
          [randomUUID(), ids.org, ids.prop, r.id],
        ),
      ),
    ).rejects.toThrow(/written by the database/);
  });

  it('files a work order note under its request too', async () => {
    await inTenant(ids.org, async (c) => {
      const r = await request(c);
      await setRequest(c, r.id, 'ACCEPTED');
      const w = await workOrder(c, { request: r.id });
      await c.query(
        `INSERT INTO maintenance_events (id, organisation_id, property_id, work_order_id, type, visibility, body, actor_user_id)
         VALUES ($1, $2, $3, $4, 'NOTE', 'INTERNAL', 'Bring a wrench', $5)`,
        [randomUUID(), ids.org, ids.prop, w.id, ids.manager],
      );
      const notes = (await events(c, 'request_id', r.id)).filter((e) => e.type === 'NOTE');
      expect(notes).toHaveLength(1);
    });
  });

  it('is append-only, even for the superuser', async () => {
    await expect(superuser.query(`UPDATE maintenance_events SET body = 'x'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(superuser.query(`DELETE FROM maintenance_events`)).rejects.toThrow(/append-only/);
    await expect(superuser.query(`TRUNCATE maintenance_events CASCADE`)).rejects.toThrow(
      /append-only/,
    );
    await expect(
      inTenant(ids.org, (c) => c.query(`DELETE FROM maintenance_requests`)),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('isolation', () => {
  it('shows another organisation nothing and refuses its writes', async () => {
    const counts = await inTenant(ids.otherOrg, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM maintenance_requests)::int AS r,
                (SELECT count(*) FROM work_orders)::int AS w,
                (SELECT count(*) FROM maintenance_events)::int AS e,
                (SELECT count(*) FROM maintenance_sla_targets)::int AS t`,
      ),
    );
    expect(counts.rows[0]).toEqual({ r: 0, w: 0, e: 0, t: 0 });
    await expect(inTenant(ids.otherOrg, (c) => request(c))).rejects.toThrow();
    // Without a tenant context nothing is visible either.
    const { rows } = await app.query(`SELECT count(*)::int AS n FROM maintenance_requests`);
    expect(rows[0].n).toBe(0);
  });
});

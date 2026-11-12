import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  claimOutboxEvents,
  createDbClient,
  markOutboxFailed,
  markOutboxPublished,
} from '../../src';

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

describe('attachments', () => {
  interface AttachmentInput {
    request?: string | null;
    work?: string | null;
    visibility?: string;
    type?: string;
    size?: number;
    name?: string;
    key?: (id: string) => string;
  }

  async function attach(c: pg.PoolClient, input: AttachmentInput): Promise<string> {
    const id = randomUUID();
    const key = input.key?.(id) ?? `org/${ids.org}/prop/${ids.prop}/maintenance/${id}`;
    await c.query(
      `INSERT INTO maintenance_attachments (id, organisation_id, property_id, request_id, work_order_id, storage_key,
         file_name, content_type, size_bytes, visibility, uploaded_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        ids.org,
        ids.prop,
        input.request ?? null,
        input.work ?? null,
        key,
        input.name ?? 'leak.jpg',
        input.type ?? 'image/jpeg',
        input.size ?? 2048,
        input.visibility ?? 'RESIDENT',
        ids.resident,
      ],
    );
    return id;
  }

  it('take only allowed types and sizes, safe names and a key under the tenant prefix', async () => {
    const r = await inTenant(ids.org, (c) => request(c));
    for (const [input, error] of [
      [{ type: 'image/svg+xml' }, /maintenance_attachments_type/],
      [{ size: 10_485_761 }, /maintenance_attachments_size/],
      [{ name: '../etc/passwd' }, /maintenance_attachments_file_name/],
      [{ key: () => `org/${ids.otherOrg}/x` }, /maintenance_attachments_key/],
    ] as const) {
      await expect(
        inTenant(ids.org, (c) => attach(c, { request: r.id, ...input })),
      ).rejects.toThrow(error);
    }
    await inTenant(ids.org, (c) => attach(c, { request: r.id, type: 'application/pdf' }));
  });

  it('are checked once and removed once; nothing else changes', async () => {
    const r = await inTenant(ids.org, (c) => request(c));
    const id = await inTenant(ids.org, (c) => attach(c, { request: r.id }));
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`UPDATE maintenance_attachments SET size_bytes = 1 WHERE id = $1`, [id]),
      ),
    ).rejects.toThrow(/checked once/);
    // Cannot be removed before it is ready.
    await expect(
      inTenant(ids.org, (c) =>
        c.query(
          `UPDATE maintenance_attachments SET removed_at = now(), removed_by_user_id = $2 WHERE id = $1`,
          [id, ids.manager],
        ),
      ),
    ).rejects.toThrow(/checked once/);
    await inTenant(ids.org, (c) =>
      c.query(`UPDATE maintenance_attachments SET status = 'READY' WHERE id = $1`, [id]),
    );
    const { rows } = await inTenant(ids.org, (c) =>
      c.query(`SELECT ready_at FROM maintenance_attachments WHERE id = $1`, [id]),
    );
    expect(rows[0].ready_at).not.toBeNull();
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`UPDATE maintenance_attachments SET status = 'REJECTED' WHERE id = $1`, [id]),
      ),
    ).rejects.toThrow(/checked once/);
    const remove = (c: pg.PoolClient) =>
      c.query(
        `UPDATE maintenance_attachments SET removed_at = now(), removed_by_user_id = $2 WHERE id = $1`,
        [id, ids.manager],
      );
    await inTenant(ids.org, remove);
    await expect(inTenant(ids.org, remove)).rejects.toThrow(/removed once/);
  });

  it('file a work order photo under its request; resident ones need a request', async () => {
    await inTenant(ids.org, async (c) => {
      const r = await request(c);
      await setRequest(c, r.id, 'ACCEPTED');
      const w = await workOrder(c, { request: r.id });
      const id = await attach(c, { work: w.id, visibility: 'INTERNAL' });
      const { rows } = await c.query(
        `SELECT request_id FROM maintenance_attachments WHERE id = $1`,
        [id],
      );
      expect(rows[0].request_id).toBe(r.id);
    });
    const direct = await inTenant(ids.org, async (c) => (await workOrder(c)).id);
    await expect(
      inTenant(ids.org, (c) => attach(c, { work: direct, visibility: 'RESIDENT' })),
    ).rejects.toThrow(/no resident to show/);
    await inTenant(ids.org, (c) => attach(c, { work: direct, visibility: 'INTERNAL' }));
  });

  it('are refused on finished requests and cancelled work, and capped at 10', async () => {
    const rejected = await inTenant(ids.org, async (c) => {
      const r = await request(c);
      await setRequest(c, r.id, 'REJECTED', 'Not ours');
      return r.id;
    });
    await expect(inTenant(ids.org, (c) => attach(c, { request: rejected }))).rejects.toThrow(
      /finished request/,
    );
    const cancelled = await inTenant(ids.org, async (c) => {
      const w = await workOrder(c);
      await setWork(c, w.id, 'CANCELLED', 'Duplicate');
      return w.id;
    });
    await expect(
      inTenant(ids.org, (c) => attach(c, { work: cancelled, visibility: 'INTERNAL' })),
    ).rejects.toThrow(/cancelled work/);

    const r = await inTenant(ids.org, (c) => request(c));
    const first = await inTenant(ids.org, async (c) => {
      const ids10: string[] = [];
      for (let i = 0; i < 10; i++) ids10.push(await attach(c, { request: r.id }));
      return ids10[0] as string;
    });
    await expect(inTenant(ids.org, (c) => attach(c, { request: r.id }))).rejects.toThrow(
      /at most 10/,
    );
    // A rejected upload frees its place.
    await inTenant(ids.org, (c) =>
      c.query(`UPDATE maintenance_attachments SET status = 'REJECTED' WHERE id = $1`, [first]),
    );
    await inTenant(ids.org, (c) => attach(c, { request: r.id }));
  });

  it('are invisible to another organisation and never deleted by the application', async () => {
    const r = await inTenant(ids.org, (c) => request(c));
    const id = await inTenant(ids.org, (c) => attach(c, { request: r.id }));
    const { rows } = await inTenant(ids.otherOrg, (c) =>
      c.query(`SELECT count(*)::int AS n FROM maintenance_attachments`),
    );
    expect(rows[0].n).toBe(0);
    await expect(
      inTenant(ids.org, (c) => c.query(`DELETE FROM maintenance_attachments WHERE id = $1`, [id])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('SLA breaches', () => {
  /** Moves a request's due times into the past (test setup only: triggers off, as superuser). */
  async function backdate(id: string, minutes = 5) {
    const client = await superuser.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL session_replication_role = replica`);
      await client.query(
        `UPDATE maintenance_requests
            SET response_due_at = now() - make_interval(mins => $2::int),
                resolution_due_at = now() - make_interval(mins => $2::int)
          WHERE id = $1`,
        [id, minutes],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const { rows } = await superuser.query(
      `SELECT response_due_at, resolution_due_at FROM maintenance_requests WHERE id = $1`,
      [id],
    );
    return rows[0] as { response_due_at: Date; resolution_due_at: Date };
  }

  const check = (c: pg.PoolClient, id: string, target: string, due: Date) =>
    c
      .query(`SELECT app_maintenance_check_breach($1, $2, $3) AS hit`, [id, target, due])
      .then((r) => r.rows[0].hit as boolean);

  it('schedules each due time in the outbox, with ids only', async () => {
    const r = await inTenant(ids.org, (c) => request(c, { priority: 'URGENT' }));
    const { rows } = await superuser.query(
      `SELECT organisation_id, type, payload, available_at FROM outbox_events
        WHERE payload->>'requestId' = $1 ORDER BY payload->>'target'`,
      [r.id],
    );
    expect(rows.map((e) => [e.type, e.payload.target])).toEqual([
      ['maintenance.sla.due', 'RESOLUTION'],
      ['maintenance.sla.due', 'RESPONSE'],
    ]);
    expect(rows[0].organisation_id).toBe(ids.org);
    expect(rows[1].available_at).toEqual(r.response_due_at);
    expect(new Date(rows[1].payload.dueAt)).toEqual(r.response_due_at);
    expect(Object.keys(rows[0].payload).sort()).toEqual([
      'dueAt',
      'propertyId',
      'requestId',
      'target',
    ]);
  });

  it('records a missed target once, in the history, and never before it is due', async () => {
    const r = await inTenant(ids.org, (c) => request(c, { priority: 'URGENT' }));
    // Not due yet.
    expect(
      await inTenant(ids.org, (c) => check(c, r.id, 'RESPONSE', r.response_due_at), null),
    ).toBe(false);
    const due = await backdate(r.id);
    expect(
      await inTenant(ids.org, (c) => check(c, r.id, 'RESPONSE', due.response_due_at), null),
    ).toBe(true);
    expect(
      await inTenant(ids.org, (c) => check(c, r.id, 'RESPONSE', due.response_due_at), null),
    ).toBe(false);
    // A stale due time (from before a change) does nothing.
    expect(
      await inTenant(ids.org, (c) => check(c, r.id, 'RESOLUTION', r.resolution_due_at), null),
    ).toBe(false);
    expect(
      await inTenant(ids.org, (c) => check(c, r.id, 'RESOLUTION', due.resolution_due_at), null),
    ).toBe(true);
    const log = await inTenant(ids.org, (c) => events(c, 'request_id', r.id));
    expect(
      log.filter((e) => e.type === 'SLA_BREACHED').map((e) => [e.visibility, e.to_value]),
    ).toEqual([
      ['INTERNAL', 'RESPONSE'],
      ['INTERNAL', 'RESOLUTION'],
    ]);
  });

  it('does not record a target that was met', async () => {
    const r = await inTenant(ids.org, async (c) => {
      const created = await request(c, { priority: 'URGENT' });
      await setRequest(c, created.id, 'ACCEPTED');
      return created;
    });
    const due = await backdate(r.id);
    // Accepted in time: the response target was met; resolution is still open.
    expect(await inTenant(ids.org, (c) => check(c, r.id, 'RESPONSE', due.response_due_at))).toBe(
      false,
    );
    expect(
      await inTenant(ids.org, (c) => check(c, r.id, 'RESOLUTION', due.resolution_due_at)),
    ).toBe(true);
  });

  it('refuses a breach that is not true, or recorded together with other changes', async () => {
    const r = await inTenant(ids.org, (c) => request(c, { priority: 'URGENT' }));
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`UPDATE maintenance_requests SET response_breached_at = now() WHERE id = $1`, [
          r.id,
        ]),
      ),
    ).rejects.toThrow(/has not been missed/);
    await backdate(r.id);
    await expect(
      inTenant(ids.org, (c) =>
        c.query(
          `UPDATE maintenance_requests SET response_breached_at = now(), status = 'ACCEPTED' WHERE id = $1`,
          [r.id],
        ),
      ),
    ).rejects.toThrow(/recorded on its own/);
  });

  it('clears a breach when a priority change moves the target into the future, and reschedules', async () => {
    const r = await inTenant(ids.org, (c) => request(c, { priority: 'URGENT' }));
    const due = await backdate(r.id);
    await inTenant(ids.org, (c) => check(c, r.id, 'RESPONSE', due.response_due_at));
    await inTenant(ids.org, (c) =>
      c.query(`UPDATE maintenance_requests SET priority = 'MEDIUM' WHERE id = $1`, [r.id]),
    );
    const { rows } = await inTenant(ids.org, (c) =>
      c.query(
        `SELECT response_breached_at, response_due_at FROM maintenance_requests WHERE id = $1`,
        [r.id],
      ),
    );
    expect(rows[0].response_breached_at).toBeNull();
    const scheduled = await superuser.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE payload->>'requestId' = $1
          AND available_at = $2`,
      [r.id, rows[0].response_due_at],
    );
    expect(scheduled.rows[0].n).toBe(1);
  });

  it('relays due outbox events once, oldest first, and holds back failures', async () => {
    const db = createDbClient(inject('appDatabaseUrl'));
    try {
      // Only this test's own events: a dedicated type.
      const type = `test.${randomUUID()}`;
      const insert = (minutesAgo: number) =>
        app.query(
          `INSERT INTO outbox_events (id, organisation_id, type, payload, available_at)
           VALUES ($1, $2, $3, '{}', now() - make_interval(mins => $4::int)) RETURNING id`,
          [randomUUID(), ids.org, type, minutesAgo],
        );
      const older = (await insert(10)).rows[0].id;
      const newer = (await insert(5)).rows[0].id;
      await app.query(
        `INSERT INTO outbox_events (id, organisation_id, type, payload, available_at)
         VALUES ($1, $2, $3, '{}', now() + interval '1 hour')`,
        [randomUUID(), ids.org, type],
      );
      const claimed = await claimOutboxEvents(db, [type], 10);
      expect(claimed.map((e) => e.id)).toEqual([older, newer]);
      expect(claimed[0]?.attempts).toBe(1);
      await markOutboxPublished(db, [older]);
      await markOutboxFailed(db, newer, 'Redis unavailable');
      // Published ones are gone; the failed one waits; the future one is not due.
      expect(await claimOutboxEvents(db, [type], 10)).toEqual([]);
      const { rows } = await app.query(
        `SELECT last_error, available_at > now() AS later FROM outbox_events WHERE id = $1`,
        [newer],
      );
      expect(rows[0]).toEqual({ last_error: 'Redis unavailable', later: true });
    } finally {
      await db.$disconnect();
    }
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

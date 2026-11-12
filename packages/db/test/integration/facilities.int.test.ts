import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Facilities (migration 20261117090000_facilities): a facility is the booking setup of an active
 * common area; opening hours never overlap; bookings are whole slots inside opening hours,
 * outside closures, within the notice and advance windows, the per-unit limit and the
 * capacity, checked under a per-facility lock so concurrent bookings cannot overbook; the
 * facility decides whether a booking waits for approval; statuses move only along the allowed
 * transitions with the reasons they need; place and time never change; history is written by
 * the database and append-only even for the superuser; everything is tenant-isolated. Runs as
 * veyra_app unless stated. The property is in Asia/Karachi (UTC+5, no daylight saving).
 */

let app: pg.Pool;
let superuser: pg.Pool;

const ids = {
  org: randomUUID(),
  otherOrg: randomUUID(),
  prop: randomUUID(),
  unit: randomUUID(),
  unit2: randomUUID(),
  unit3: randomUUID(),
  unit4: randomUUID(),
  poolArea: randomUUID(),
  hallArea: randomUUID(),
  gymArea: randomUUID(),
  spareArea: randomUUID(),
  archivedArea: randomUUID(),
  pool: randomUUID(),
  hall: randomUUID(),
  gym: randomUUID(),
  resident: randomUUID(),
  manager: randomUUID(),
};

async function inTenant<T>(
  organisationId: string,
  work: (c: pg.PoolClient) => Promise<T>,
  userId: string | null = ids.resident,
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

const asManager = <T>(work: (c: pg.PoolClient) => Promise<T>) =>
  inTenant(ids.org, work, ids.manager);

/** A property-local time `day` days from today, `minutes` after midnight (integers only). */
const at = (day: number, minutes: number) =>
  `((((now() AT TIME ZONE 'Asia/Karachi')::date + ${Math.trunc(day)}) + make_interval(mins => ${Math.trunc(minutes)})) AT TIME ZONE 'Asia/Karachi')`;

interface BookingInput {
  facility?: string;
  unit?: string;
  day: number;
  /** Start and end, minutes after local midnight. */
  from: number;
  to: number;
  status?: string;
}

async function book(c: pg.PoolClient, input: BookingInput) {
  const id = randomUUID();
  const { rows } = await c.query(
    `INSERT INTO facility_bookings (id, organisation_id, property_id, facility_id, unit_id, starts_at, ends_at,
       status, booked_by_user_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, ${at(input.day, input.from)}, ${at(input.day, input.to)}, $6, $7,
             now() - interval '1 day', now())
     RETURNING booking_number, status, slot_count, created_at`,
    [
      id,
      ids.org,
      ids.prop,
      input.facility ?? ids.pool,
      input.unit ?? ids.unit,
      input.status ?? 'PENDING',
      ids.resident,
    ],
  );
  return { id, ...rows[0], number: Number(rows[0].booking_number) };
}

const setBooking = (c: pg.PoolClient, id: string, status: string, note: string | null = null) =>
  c.query(`UPDATE facility_bookings SET status = $2, status_note = $3 WHERE id = $1`, [
    id,
    status,
    note,
  ]);

const history = (c: pg.PoolClient, id: string) =>
  c
    .query(
      `SELECT from_status, to_status, note, actor_user_id FROM facility_booking_events
        WHERE booking_id = $1 ORDER BY sequence`,
      [id],
    )
    .then((r) => r.rows);

/** Moves a booking into the past (test setup only: triggers off, as superuser). */
async function backdate(id: string) {
  const client = await superuser.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL session_replication_role = replica`);
    await client.query(
      `UPDATE facility_bookings SET starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour'
        WHERE id = $1`,
      [id],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

async function closure(c: pg.PoolClient, facility: string, day: number, from: number, to: number) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO facility_closures (id, organisation_id, property_id, facility_id, starts_at, ends_at, reason,
       created_by_user_id)
     VALUES ($1, $2, $3, $4, ${at(day, from)}, ${at(day, to)}, 'Pump repair', $5)`,
    [id, ids.org, ids.prop, facility, ids.manager],
  );
  return id;
}

interface FacilityInput {
  id?: string;
  area: string;
  slot?: number;
  capacity?: number;
  approval?: boolean;
  notice?: number;
  maxSlots?: number;
  perUnit?: number | null;
  status?: string;
}

const facility = (c: pg.PoolClient, f: FacilityInput) =>
  c.query(
    `INSERT INTO facilities (id, organisation_id, property_id, common_area_id, status, slot_minutes, capacity,
       approval_required, min_notice_minutes, max_slots_per_booking, max_upcoming_per_unit, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
    [
      f.id ?? randomUUID(),
      ids.org,
      ids.prop,
      f.area,
      f.status ?? 'ACTIVE',
      f.slot ?? 60,
      f.capacity ?? 1,
      f.approval ?? false,
      f.notice ?? 0,
      f.maxSlots ?? 3,
      f.perUnit ?? null,
    ],
  );

const hours = (
  c: pg.PoolClient,
  facilityId: string,
  weekday: number,
  opens: string,
  closes: string,
) =>
  c.query(
    `INSERT INTO facility_opening_hours (id, organisation_id, property_id, facility_id, weekday, opens_at, closes_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), ids.org, ids.prop, facilityId, weekday, opens, closes],
  );

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 4 });
  superuser = new pg.Pool({ connectionString: inject('superuserDatabaseUrl'), max: 1 });
  for (const [id, name] of [
    [ids.resident, 'Resident'],
    [ids.manager, 'Manager'],
  ] as const) {
    await app.query(
      `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, $3, now())`,
      [id, `fac-${id}@example.test`, name],
    );
  }
  for (const org of [ids.org, ids.otherOrg]) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `fc-${org.slice(0, 8)}`],
      ),
    );
  }
  await asManager(async (c) => {
    await c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Facilities', 'FC', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    );
    for (const [id, number] of [
      [ids.unit, 'F1'],
      [ids.unit2, 'F2'],
      [ids.unit3, 'F3'],
      [ids.unit4, 'F4'],
    ] as const) {
      await c.query(
        `INSERT INTO units (id, organisation_id, property_id, number, type, updated_at)
         VALUES ($1, $2, $3, $4, 'APARTMENT', now())`,
        [id, ids.org, ids.prop, number],
      );
    }
    for (const [id, name, type, status] of [
      [ids.poolArea, 'Pool', 'POOL', 'ACTIVE'],
      [ids.hallArea, 'Hall', 'FUNCTION_ROOM', 'ACTIVE'],
      [ids.gymArea, 'Gym', 'GYM', 'ACTIVE'],
      [ids.spareArea, 'Court', 'SPORTS_FACILITY', 'ACTIVE'],
      [ids.archivedArea, 'Old room', 'OTHER', 'ARCHIVED'],
    ] as const) {
      await c.query(
        `INSERT INTO common_areas (id, organisation_id, property_id, name, type, status, archived_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [id, ids.org, ids.prop, name, type, status, status === 'ARCHIVED' ? new Date() : null],
      );
    }
    // Pool: exclusive, hourly slots 06:00-22:00, up to 3 slots, confirmed at once.
    await facility(c, { id: ids.pool, area: ids.poolArea });
    // Hall: needs approval, a unit holds at most 2 upcoming bookings.
    await facility(c, { id: ids.hall, area: ids.hallArea, approval: true, perUnit: 2 });
    // Gym: two at a time, half-hour slots, booked at least two days ahead.
    await facility(c, { id: ids.gym, area: ids.gymArea, slot: 30, capacity: 2, notice: 2880 });
    for (let day = 1; day <= 7; day++) {
      await hours(c, ids.pool, day, '06:00', '22:00');
      await hours(c, ids.hall, day, '00:00', '24:00');
      await hours(c, ids.gym, day, '00:00', '24:00');
    }
  });
});

afterAll(async () => {
  await app?.end();
  await superuser?.end();
});

describe('facilities', () => {
  it('are set up for an active common area, once, with sensible settings', async () => {
    await expect(asManager((c) => facility(c, { area: ids.archivedArea }))).rejects.toThrow(
      /common area is archived/,
    );
    await expect(asManager((c) => facility(c, { area: ids.poolArea }))).rejects.toThrow(
      /common_area_id_key/,
    );
    for (const bad of [{ slot: 7 }, { capacity: 0 }, { maxSlots: 0 }, { perUnit: 0 }]) {
      await expect(asManager((c) => facility(c, { area: ids.spareArea, ...bad }))).rejects.toThrow(
        /facilities_settings/,
      );
    }
    await expect(
      asManager((c) => facility(c, { area: ids.spareArea, status: 'ARCHIVED' })),
    ).rejects.toThrow(/start active/);
  });

  it('have opening hours that never overlap on a day', async () => {
    await expect(asManager((c) => hours(c, ids.pool, 1, '21:00', '23:00'))).rejects.toThrow(
      /cannot overlap/,
    );
    await expect(asManager((c) => hours(c, ids.pool, 1, '23:00', '22:30'))).rejects.toThrow(
      /opening_hours_range/,
    );
    // Touching ranges are fine; replaced hours are deleted.
    await asManager(async (c) => {
      await hours(c, ids.pool, 1, '22:00', '23:00');
      await c.query(
        `DELETE FROM facility_opening_hours WHERE facility_id = $1 AND weekday = 1 AND opens_at = '22:00'`,
        [ids.pool],
      );
    });
  });

  it('are archived only once nothing upcoming is booked, and then never change', async () => {
    const id = randomUUID();
    await asManager(async (c) => {
      await facility(c, { id, area: ids.spareArea });
      await hours(c, id, 1, '00:00', '24:00');
      for (let day = 2; day <= 7; day++) await hours(c, id, day, '00:00', '24:00');
    });
    const b = await inTenant(ids.org, (c) => book(c, { facility: id, day: 2, from: 600, to: 660 }));
    await expect(
      asManager((c) => c.query(`UPDATE facilities SET status = 'ARCHIVED' WHERE id = $1`, [id])),
    ).rejects.toThrow(/cancel the upcoming bookings/);
    await inTenant(ids.org, (c) => setBooking(c, b.id, 'CANCELLED', 'Plans changed'));
    await asManager(async (c) => {
      await c.query(`UPDATE facilities SET status = 'ARCHIVED' WHERE id = $1`, [id]);
      const { rows } = await c.query(`SELECT archived_at FROM facilities WHERE id = $1`, [id]);
      expect(rows[0].archived_at).not.toBeNull();
    });
    await expect(
      asManager((c) => c.query(`UPDATE facilities SET capacity = 5 WHERE id = $1`, [id])),
    ).rejects.toThrow(/archived and no longer changes/);
    await expect(
      inTenant(ids.org, (c) => book(c, { facility: id, day: 3, from: 600, to: 660 })),
    ).rejects.toThrow(/facility is archived/);
  });
});

describe('bookings', () => {
  it('are numbered per property, counted in slots, and confirmed or held by the facility setting', async () => {
    await inTenant(ids.org, async (c) => {
      const a = await book(c, { day: 1, from: 6 * 60, to: 8 * 60 });
      expect(a).toMatchObject({ status: 'CONFIRMED', slot_count: 2 });
      // The client cannot skip approval nor backdate.
      const b = await book(c, {
        facility: ids.hall,
        day: 1,
        from: 600,
        to: 660,
        status: 'CONFIRMED',
      });
      expect(b.status).toBe('PENDING');
      expect(b.number).toBe(a.number + 1);
      expect(Date.now() - b.created_at.getTime()).toBeLessThan(60_000);
      expect(await history(c, b.id)).toEqual([
        { from_status: null, to_status: 'PENDING', note: null, actor_user_id: ids.resident },
      ]);
    });
  });

  it('are whole slots inside the opening hours, up to the facility maximum', async () => {
    const cases: [BookingInput, RegExp][] = [
      [{ day: 2, from: 630, to: 690 }, /whole 60 minute slots/], // off the slot boundary
      [{ day: 2, from: 300, to: 420 }, /whole 60 minute slots/], // opens at 06:00
      [{ day: 2, from: 21 * 60, to: 23 * 60 }, /whole 60 minute slots/], // closes at 22:00
      [{ day: 2, from: 600, to: 630 }, /whole 60 minute slots/], // half a slot
      [{ day: 2, from: 600, to: 600 }, /whole 60 minute slots/],
      [{ day: 2, from: 6 * 60, to: 10 * 60 }, /at most 3 slots/],
    ];
    for (const [input, error] of cases) {
      await expect(inTenant(ids.org, (c) => book(c, input))).rejects.toThrow(error);
    }
    // Half-hour slots on the gym.
    await inTenant(ids.org, (c) => book(c, { facility: ids.gym, day: 3, from: 630, to: 660 }));
  });

  it('respect the notice and advance windows', async () => {
    await expect(
      inTenant(ids.org, (c) => book(c, { facility: ids.gym, day: 1, from: 600, to: 630 })),
    ).rejects.toThrow(/at least 2880 minutes ahead/);
    await expect(
      inTenant(ids.org, (c) => book(c, { day: 40, from: 600, to: 660 })),
    ).rejects.toThrow(/at most 30 days ahead/);
    await expect(
      inTenant(ids.org, (c) => book(c, { day: -1, from: 600, to: 660 })),
    ).rejects.toThrow(/at least 0 minutes ahead/);
  });

  it('never overbook: exclusive use, shared capacity, pending ones hold their place', async () => {
    await inTenant(ids.org, async (c) => {
      await book(c, { day: 4, from: 600, to: 720 });
      // Back to back is fine.
      await book(c, { day: 4, from: 720, to: 780 });
    });
    await expect(inTenant(ids.org, (c) => book(c, { day: 4, from: 660, to: 720 }))).rejects.toThrow(
      /fully booked/,
    );
    // Gym: two at once, the third is refused where they overlap.
    await inTenant(ids.org, async (c) => {
      await book(c, { facility: ids.gym, day: 4, from: 600, to: 660 });
      await book(c, { facility: ids.gym, day: 4, from: 630, to: 690, unit: ids.unit2 });
      await book(c, { facility: ids.gym, day: 4, from: 660, to: 720 });
    });
    await expect(
      inTenant(ids.org, (c) => book(c, { facility: ids.gym, day: 4, from: 600, to: 690 })),
    ).rejects.toThrow(/fully booked/);
    // A pending hall booking holds its place; once rejected the time is free again.
    const held = await inTenant(ids.org, (c) =>
      book(c, { facility: ids.hall, day: 4, from: 600, to: 660 }),
    );
    await expect(
      inTenant(ids.org, (c) =>
        book(c, { facility: ids.hall, day: 4, from: 600, to: 660, unit: ids.unit2 }),
      ),
    ).rejects.toThrow(/fully booked/);
    await asManager((c) => setBooking(c, held.id, 'REJECTED', 'Private event'));
    await inTenant(ids.org, (c) =>
      book(c, { facility: ids.hall, day: 4, from: 600, to: 660, unit: ids.unit2 }),
    );
  });

  it('cannot overbook when two people book the same slot at the same time', async () => {
    const first = await app.connect();
    const second = await app.connect();
    try {
      for (const c of [first, second]) {
        await c.query('BEGIN');
        await c.query("SELECT set_config('app.organisation_id', $1, true)", [ids.org]);
      }
      await book(first, { day: 5, from: 600, to: 660 });
      const racing = book(second, { day: 5, from: 600, to: 660, unit: ids.unit2 });
      await first.query('COMMIT');
      await expect(racing).rejects.toThrow(/fully booked/);
    } finally {
      await second.query('ROLLBACK').catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it('respect the per-unit limit of upcoming bookings', async () => {
    // The unit already holds a pending hall booking from the first booking test (day 1).
    const a = await inTenant(ids.org, (c) =>
      book(c, { facility: ids.hall, day: 6, from: 600, to: 660 }),
    );
    await expect(
      inTenant(ids.org, (c) => book(c, { facility: ids.hall, day: 7, from: 600, to: 660 })),
    ).rejects.toThrow(/2 upcoming bookings/);
    // Another unit is not affected; a cancelled booking frees the allowance.
    await inTenant(ids.org, (c) =>
      book(c, { facility: ids.hall, day: 7, from: 600, to: 660, unit: ids.unit2 }),
    );
    await inTenant(ids.org, (c) => setBooking(c, a.id, 'CANCELLED'));
    await inTenant(ids.org, (c) => book(c, { facility: ids.hall, day: 7, from: 720, to: 780 }));
  });
});

describe('closures', () => {
  it('block bookings until lifted, and never cover a live booking', async () => {
    const id = await asManager((c) => closure(c, ids.pool, 8, 0, 24 * 60));
    await expect(inTenant(ids.org, (c) => book(c, { day: 8, from: 600, to: 660 }))).rejects.toThrow(
      /closed then/,
    );
    const live = await inTenant(ids.org, (c) => book(c, { day: 9, from: 600, to: 660 }));
    await expect(asManager((c) => closure(c, ids.pool, 9, 540, 620))).rejects.toThrow(
      /cancel the bookings in that period/,
    );
    await asManager((c) => setBooking(c, live.id, 'CANCELLED', 'Pump repair'));
    await asManager((c) => closure(c, ids.pool, 9, 540, 620));

    await expect(
      asManager((c) =>
        c.query(`UPDATE facility_closures SET reason = 'Other' WHERE id = $1`, [id]),
      ),
    ).rejects.toThrow(/never edited/);
    await asManager(async (c) => {
      await c.query(`UPDATE facility_closures SET lifted_by_user_id = $2 WHERE id = $1`, [
        id,
        ids.manager,
      ]);
      const { rows } = await c.query(`SELECT lifted_at FROM facility_closures WHERE id = $1`, [id]);
      expect(rows[0].lifted_at).not.toBeNull();
    });
    await expect(
      asManager((c) =>
        c.query(`UPDATE facility_closures SET lifted_by_user_id = $2 WHERE id = $1`, [
          id,
          ids.resident,
        ]),
      ),
    ).rejects.toThrow(/never edited/);
    await inTenant(ids.org, (c) => book(c, { day: 8, from: 600, to: 660 }));
  });
});

describe('status', () => {
  it('moves only along the allowed transitions, with reasons where needed', async () => {
    const b = await inTenant(ids.org, (c) =>
      book(c, { facility: ids.hall, day: 10, from: 600, to: 660, unit: ids.unit3 }),
    );
    await expect(asManager((c) => setBooking(c, b.id, 'REJECTED'))).rejects.toThrow(
      /reason to reject/,
    );
    await expect(asManager((c) => setBooking(c, b.id, 'COMPLETED'))).rejects.toThrow(
      /cannot go from pending to completed/,
    );
    await asManager((c) => setBooking(c, b.id, 'CONFIRMED', 'ignored'));
    await expect(asManager((c) => setBooking(c, b.id, 'CANCELLED'))).rejects.toThrow(
      /reason to cancel/,
    );
    await expect(asManager((c) => setBooking(c, b.id, 'NO_SHOW'))).rejects.toThrow(
      /once it has started/,
    );
    await expect(
      asManager((c) =>
        c.query(
          `UPDATE facility_bookings SET ends_at = ends_at + interval '1 hour' WHERE id = $1`,
          [b.id],
        ),
      ),
    ).rejects.toThrow(/cannot change place or time/);

    await backdate(b.id);
    await asManager((c) => setBooking(c, b.id, 'COMPLETED'));
    await expect(asManager((c) => setBooking(c, b.id, 'NO_SHOW'))).rejects.toThrow(
      /completed and no longer changes/,
    );
    await asManager(async (c) => {
      const { rows } = await c.query(
        `SELECT decided_by_user_id, decided_at, status_note FROM facility_bookings WHERE id = $1`,
        [b.id],
      );
      expect(rows[0]).toMatchObject({ decided_by_user_id: ids.manager, status_note: null });
      expect(rows[0].decided_at).not.toBeNull();
      expect(
        (await history(c, b.id)).map((e) => [e.from_status, e.to_status, e.actor_user_id]),
      ).toEqual([
        [null, 'PENDING', ids.resident],
        ['PENDING', 'CONFIRMED', ids.manager],
        ['CONFIRMED', 'COMPLETED', ids.manager],
      ]);
    });
  });

  it('records rejections with their reason and decider', async () => {
    const b = await inTenant(ids.org, (c) =>
      book(c, { facility: ids.hall, day: 11, from: 600, to: 660, unit: ids.unit4 }),
    );
    await asManager((c) => setBooking(c, b.id, 'REJECTED', 'Hall is being painted'));
    await asManager(async (c) => {
      const log = await history(c, b.id);
      expect(log.at(-1)).toEqual({
        from_status: 'PENDING',
        to_status: 'REJECTED',
        note: 'Hall is being painted',
        actor_user_id: ids.manager,
      });
    });
    // An approval needs a person.
    const anon = await inTenant(ids.org, (c) =>
      book(c, { facility: ids.hall, day: 12, from: 600, to: 660, unit: ids.unit4 }),
    );
    await expect(
      inTenant(ids.org, (c) => setBooking(c, anon.id, 'CONFIRMED'), null),
    ).rejects.toThrow(/by a person/);
  });
});

describe('history', () => {
  it('is written only by the database and append-only, even for the superuser', async () => {
    const b = await inTenant(ids.org, (c) => book(c, { day: 13, from: 600, to: 660 }));
    await expect(
      inTenant(ids.org, (c) =>
        c.query(
          `INSERT INTO facility_booking_events (id, organisation_id, property_id, booking_id, to_status)
           VALUES ($1, $2, $3, $4, 'CANCELLED')`,
          [randomUUID(), ids.org, ids.prop, b.id],
        ),
      ),
    ).rejects.toThrow(/written by the database/);
    await expect(superuser.query(`UPDATE facility_booking_events SET note = 'x'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(superuser.query(`DELETE FROM facility_booking_events`)).rejects.toThrow(
      /append-only/,
    );
    await expect(superuser.query(`TRUNCATE facility_booking_events CASCADE`)).rejects.toThrow(
      /append-only/,
    );
    await expect(
      inTenant(ids.org, (c) => c.query(`DELETE FROM facility_bookings WHERE id = $1`, [b.id])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('isolation', () => {
  it('shows another organisation nothing and refuses its writes', async () => {
    const counts = await inTenant(ids.otherOrg, (c) =>
      c.query(
        `SELECT (SELECT count(*) FROM facilities)::int AS f,
                (SELECT count(*) FROM facility_opening_hours)::int AS h,
                (SELECT count(*) FROM facility_closures)::int AS c,
                (SELECT count(*) FROM facility_bookings)::int AS b,
                (SELECT count(*) FROM facility_booking_events)::int AS e`,
      ),
    );
    expect(counts.rows[0]).toEqual({ f: 0, h: 0, c: 0, b: 0, e: 0 });
    await expect(
      inTenant(ids.otherOrg, (c) => book(c, { day: 14, from: 600, to: 660 })),
    ).rejects.toThrow();
    const { rows } = await app.query(`SELECT count(*)::int AS n FROM facility_bookings`);
    expect(rows[0].n).toBe(0);
  });
});

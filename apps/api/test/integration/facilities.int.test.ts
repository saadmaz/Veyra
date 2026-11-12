import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadApiEnv } from '../../src/platform/config/env';
import { REDIS_CLIENT } from '../../src/platform/infrastructure/infrastructure.module';
import { RATE_LIMITER } from '../../src/platform/rate-limit/rate-limiter';
import { InMemoryRateLimiter } from '../support/in-memory-rate-limiter';

/**
 * Facilities over HTTP against the real database (Phase 8 Part 2): managers set up facilities,
 * hours and closures; owners and tenants see availability in the property's time zone, book and
 * cancel for their unit only; household members do not book; capacity, slot and window rules
 * come back as clear errors; staff approve, reject and cancel; properties and units are isolated.
 * The property is in Asia/Karachi (UTC+5, no daylight saving).
 */

const PASSWORD = 'correct horse battery staple';
let app: INestApplication;
const run = randomUUID().slice(0, 8);
const http = () => request(app.getHttpServer());

interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

async function signUp(name: string): Promise<TestUser> {
  const email = `${name}-${run}@example.test`;
  const res = await http()
    .post('/api/v1/auth/sign-up')
    .send({ email, password: PASSWORD, displayName: name })
    .expect(201);
  const setCookie = (res.headers['set-cookie'] as unknown as string[])[0] as string;
  return { id: res.body.user.id, email, cookie: setCookie.split(';')[0] as string };
}

const as = (user: TestUser) => ({
  get: (url: string) => http().get(url).set('Cookie', user.cookie),
  post: (url: string) => http().post(url).set('Cookie', user.cookie),
  patch: (url: string) => http().patch(url).set('Cookie', user.cookie),
  put: (url: string) => http().put(url).set('Cookie', user.cookie),
});

const NAMES = [
  'admin',
  'mgr',
  'mgrq',
  'supervisor',
  'finance',
  'tenant',
  'child',
  'neighbour',
] as const;
const u = {} as Record<(typeof NAMES)[number], TestUser>;
let org: string;
let P: string;
let Q: string;
const areas: Record<string, string> = {};
const units: Record<string, string> = {};
let pool: string;
let hall: string;
const orgUrl = () => `/api/v1/organisations/${org}`;
const pUrl = (p = P) => `${orgUrl()}/properties/${p}`;
const fUrl = (path = '', p = P) => `${pUrl(p)}/facilities${path ? `/${path}` : ''}`;
const bUrl = (path = '') => `${pUrl()}/facility-bookings${path ? `/${path}` : ''}`;
const unitUrl = (unit: string, path: string) => `${pUrl()}/units/${units[unit]}/${path}`;

/** The property-local date `days` from today (Karachi is UTC+5). */
const localDate = (days: number) =>
  new Date(Date.now() + 5 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
/** That date at a local "HH:MM", as an instant. */
const at = (days: number, time: string) => `${localDate(days)}T${time}:00+05:00`;

const everyDay = (opensAt: string, closesAt: string) =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, opensAt, closesAt }));

const book = (user: TestUser, unit: string, body: Record<string, unknown>) =>
  as(user).post(unitUrl(unit, 'facility-bookings')).send(body);

beforeAll(async () => {
  const env = loadApiEnv({
    NODE_ENV: 'test',
    DATABASE_URL: inject('appDatabaseUrl'),
    REDIS_URL: 'redis://localhost:6379',
    API_CORS_ORIGINS: 'http://localhost:3000',
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(REDIS_CLIENT)
    .useValue({ quit: async () => 'OK' })
    .overrideProvider(RATE_LIMITER)
    .useValue(new InMemoryRateLimiter())
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, env);
  await app.init();

  const users = await Promise.all(NAMES.map(signUp));
  NAMES.forEach((name, i) => {
    u[name] = users[i] as TestUser;
  });
  org = (
    await as(u.admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Facilities Org',
        slug: `fac-${run}`,
        countryCode: 'PK',
        defaultCurrency: 'PKR',
        defaultTimeZone: 'Asia/Karachi',
      })
      .expect(201)
  ).body.id;
  const property = async (code: string) =>
    (
      await as(u.admin)
        .post(`${orgUrl()}/properties`)
        .send({
          name: `Leisure ${code}`,
          code,
          type: 'CONDOMINIUM',
          addressLine1: '1 Road',
          city: 'Karachi',
        })
        .expect(201)
    ).body.id as string;
  P = await property('LP');
  Q = await property('LQ');
  for (const [user, role, propertyId] of [
    [u.mgr, 'PROPERTY_MANAGER', P],
    [u.mgrq, 'PROPERTY_MANAGER', Q],
    [u.supervisor, 'SECURITY_SUPERVISOR', P],
    [u.finance, 'FINANCE_OFFICER', undefined],
  ] as const) {
    const invited = await as(u.admin)
      .post(`${orgUrl()}/invitations`)
      .send({ email: user.email, role, ...(propertyId ? { propertyId } : {}) })
      .expect(201);
    await as(user)
      .post('/api/v1/invitations/accept')
      .send({ token: invited.body.token })
      .expect(200);
  }
  for (const number of ['U1', 'U2']) {
    units[number] = (
      await as(u.admin).post(`${pUrl()}/units`).send({ number, type: 'APARTMENT' }).expect(201)
    ).body.id;
  }
  for (const [name, type] of [
    ['Pool', 'POOL'],
    ['Hall', 'FUNCTION_ROOM'],
    ['Court', 'SPORTS_FACILITY'],
  ] as const) {
    areas[name] = (
      await as(u.admin).post(`${pUrl()}/common-areas`).send({ name, type }).expect(201)
    ).body.id;
  }

  const resident = async (user: TestUser, fullName: string) => {
    const person = (
      await as(u.admin).post(`${pUrl()}/persons`).send({ fullName, email: user.email }).expect(201)
    ).body.id as string;
    return {
      person,
      link: async () => {
        const invited = await as(u.admin)
          .post(`${orgUrl()}/persons/${person}/invitations`)
          .expect(201);
        await as(user)
          .post('/api/v1/invitations/accept')
          .send({ token: invited.body.token })
          .expect(200);
      },
    };
  };
  const t = await resident(u.tenant, 'Tara Tenant');
  await as(u.admin)
    .post(`${pUrl()}/units/${units.U1}/tenancies`)
    .send({ startDate: '2026-01-01', occupants: [{ personId: t.person, isPrimary: true }] })
    .expect(201);
  const c = await resident(u.child, 'Kid Household');
  await as(u.admin)
    .post(`${pUrl()}/units/${units.U1}/household`)
    .send({ personId: c.person, relationship: 'CHILD', validFrom: '2026-01-01' })
    .expect(201);
  const n = await resident(u.neighbour, 'Ola Neighbour');
  await as(u.admin)
    .post(`${pUrl()}/units/${units.U2}/owners`)
    .send({
      effectiveFrom: '2026-01-01',
      owners: [{ personId: n.person, shareNumerator: 1, shareDenominator: 1 }],
    })
    .expect(200);
  for (const r of [t, c, n]) await r.link();

  pool = (
    await as(u.mgr)
      .post(fUrl())
      .send({
        commonAreaId: areas.Pool,
        description: 'No glass by the pool',
        slotMinutes: 60,
        maxSlotsPerBooking: 2,
        cancellationMinutes: 120,
        openingHours: everyDay('06:00', '22:00'),
      })
      .expect(201)
  ).body.facility.id;
  hall = (
    await as(u.mgr)
      .post(fUrl())
      .send({
        commonAreaId: areas.Hall,
        slotMinutes: 60,
        approvalRequired: true,
        maxSlotsPerBooking: 4,
        openingHours: everyDay('00:00', '24:00'),
      })
      .expect(201)
  ).body.facility.id;
});

afterAll(async () => {
  await app?.close();
});

describe('setup', () => {
  it('is for managers; one facility per common area; hours are checked', async () => {
    const detail = (await as(u.mgr).get(fUrl(pool)).expect(200)).body;
    expect(detail.facility).toMatchObject({
      name: 'Pool',
      type: 'POOL',
      capacity: 1,
      timeZone: 'Asia/Karachi',
      openingHours: expect.arrayContaining([{ weekday: 1, opensAt: '06:00', closesAt: '22:00' }]),
    });
    const hallHours = (await as(u.mgr).get(fUrl(hall)).expect(200)).body.facility.openingHours;
    expect(hallHours[0]).toEqual({ weekday: 1, opensAt: '00:00', closesAt: '24:00' });

    await as(u.mgr).post(fUrl()).send({ commonAreaId: areas.Pool, slotMinutes: 30 }).expect(409);
    await as(u.mgr)
      .post(fUrl())
      .send({
        commonAreaId: areas.Court,
        slotMinutes: 60,
        openingHours: [
          { weekday: 1, opensAt: '06:00', closesAt: '12:00' },
          { weekday: 1, opensAt: '11:00', closesAt: '13:00' },
        ],
      })
      .expect(400);
    await as(u.tenant)
      .post(fUrl())
      .send({ commonAreaId: areas.Court, slotMinutes: 60 })
      .expect(404);
    await as(u.finance).get(fUrl()).expect(403);
    // The security supervisor sees facilities and bookings, but changes nothing.
    await as(u.supervisor).get(fUrl()).expect(200);
    await as(u.supervisor).get(bUrl()).expect(200);
    await as(u.supervisor).patch(fUrl(pool)).send({ capacity: 2 }).expect(403);
  });

  it('keeps properties apart', async () => {
    await as(u.mgrq).get(fUrl()).expect(404);
    expect((await as(u.mgrq).get(fUrl('', Q)).expect(200)).body.data).toEqual([]);
    await as(u.mgrq).get(fUrl(pool, Q)).expect(404);
  });
});

describe('residents', () => {
  it('see availability in local time and book whole slots for their unit', async () => {
    const list = (await as(u.tenant).get(unitUrl('U1', 'facilities')).expect(200)).body.data;
    expect(list.map((f: { name: string }) => f.name)).toEqual(['Hall', 'Pool']);

    const day = (
      await as(u.tenant)
        .get(unitUrl('U1', `facilities/${pool}/availability?date=${localDate(3)}`))
        .expect(200)
    ).body;
    expect(day.slots).toHaveLength(16);
    expect(day.slots[0]).toMatchObject({
      time: '06:00',
      startsAt: new Date(at(3, '06:00')).toISOString(),
      state: 'OPEN',
      available: 1,
    });

    const created = await book(u.tenant, 'U1', {
      facilityId: pool,
      startsAt: at(3, '10:00'),
      slots: 2,
      purpose: 'Swimming lesson',
    }).expect(201);
    expect(created.body.booking).toMatchObject({
      status: 'CONFIRMED',
      slotCount: 2,
      unitNumber: 'U1',
      facilityName: 'Pool',
      endsAt: new Date(at(3, '12:00')).toISOString(),
      bookedBy: { userId: u.tenant.id },
      cancellable: true,
    });
    expect(created.body.booking.number).toMatch(/^BK-\d{6}$/);
    expect(created.body.events).toHaveLength(1);

    const after = (
      await as(u.neighbour)
        .get(`${pUrl()}/units/${units.U2}/facilities/${pool}/availability?date=${localDate(3)}`)
        .expect(200)
    ).body.slots;
    expect(
      after
        .filter((s: { state: string }) => s.state === 'FULL')
        .map((s: { time: string }) => s.time),
    ).toEqual(['10:00', '11:00']);
  });

  it('get clear answers when a time cannot be booked', async () => {
    const cases: [Record<string, unknown>, number, string][] = [
      [{ startsAt: at(3, '11:00') }, 409, 'SLOT_UNAVAILABLE'],
      [{ startsAt: at(5, '10:30') }, 422, 'INVALID_BOOKING_TIME'],
      [{ startsAt: at(5, '05:00') }, 422, 'INVALID_BOOKING_TIME'],
      [{ startsAt: at(5, '10:00'), slots: 3 }, 422, 'INVALID_BOOKING_TIME'],
      [{ startsAt: at(40, '10:00') }, 422, 'INVALID_BOOKING_TIME'],
    ];
    for (const [body, status, code] of cases) {
      const res = await book(u.neighbour, 'U2', { facilityId: pool, ...body }).expect(status);
      expect(res.body.error.code).toBe(code);
    }
  });

  it('book and see their own unit only; household members do not book', async () => {
    await book(u.child, 'U1', { facilityId: pool, startsAt: at(6, '10:00') }).expect(403);
    await as(u.child).get(unitUrl('U1', 'facilities')).expect(403);
    await as(u.neighbour).get(unitUrl('U1', 'facility-bookings')).expect(404);
    const tenants = (await as(u.tenant).get(unitUrl('U1', 'facility-bookings')).expect(200)).body
      .data;
    expect(tenants.length).toBeGreaterThan(0);
    await as(u.neighbour)
      .get(`${pUrl()}/units/${units.U2}/facility-bookings/${tenants[0].id}`)
      .expect(404);
    // Staff book on a resident's behalf through the unit's routes.
    const staff = await book(u.mgr, 'U2', { facilityId: pool, startsAt: at(6, '15:00') }).expect(
      201,
    );
    expect(staff.body.booking.bookedBy.userId).toBe(u.mgr.id);
  });

  it('cancel before the cancellation window; staff cancel later, with a reason', async () => {
    const b = (
      await book(u.tenant, 'U1', { facilityId: pool, startsAt: at(7, '08:00') }).expect(201)
    ).body.booking;
    const cancelled = await as(u.tenant)
      .post(unitUrl('U1', `facility-bookings/${b.id}/cancel`))
      .send({})
      .expect(200);
    expect(cancelled.body.booking).toMatchObject({
      status: 'CANCELLED',
      statusNote: 'Cancelled by the resident',
      cancellable: false,
    });
    await as(u.tenant)
      .post(unitUrl('U1', `facility-bookings/${b.id}/cancel`))
      .send({})
      .expect(409);

    // A window longer than the time left: residents can no longer cancel.
    await as(u.mgr).patch(fUrl(pool)).send({ cancellationMinutes: 525600 }).expect(200);
    const late = (
      await book(u.tenant, 'U1', { facilityId: pool, startsAt: at(7, '09:00') }).expect(201)
    ).body.booking;
    expect(late.cancellable).toBe(false);
    const refused = await as(u.tenant)
      .post(unitUrl('U1', `facility-bookings/${late.id}/cancel`))
      .send({})
      .expect(409);
    expect(refused.body.error.code).toBe('TOO_LATE_TO_CANCEL');
    await as(u.mgr)
      .post(bUrl(`${late.id}/cancel`))
      .send({})
      .expect(422);
    await as(u.mgr)
      .post(bUrl(`${late.id}/cancel`))
      .send({ reason: 'Pool cleaning' })
      .expect(200);
    await as(u.mgr).patch(fUrl(pool)).send({ cancellationMinutes: 120 }).expect(200);
  });
});

describe('approval', () => {
  it('holds hall bookings for a manager, who approves or rejects with a reason', async () => {
    const pending = (
      await book(u.tenant, 'U1', { facilityId: hall, startsAt: at(8, '18:00'), slots: 3 }).expect(
        201,
      )
    ).body.booking;
    expect(pending.status).toBe('PENDING');
    // The pending booking holds its place.
    await book(u.neighbour, 'U2', { facilityId: hall, startsAt: at(8, '19:00') }).expect(409);
    await as(u.tenant)
      .post(bUrl(`${pending.id}/approve`))
      .expect(404);

    const queue = (await as(u.mgr).get(`${bUrl()}?status=PENDING&facilityId=${hall}`).expect(200))
      .body.data;
    expect(queue.map((b: { id: string }) => b.id)).toContain(pending.id);
    const approved = (
      await as(u.mgr)
        .post(bUrl(`${pending.id}/approve`))
        .expect(200)
    ).body;
    expect(approved.booking.status).toBe('CONFIRMED');
    expect(approved.events.map((e: { toStatus: string }) => e.toStatus)).toEqual([
      'PENDING',
      'CONFIRMED',
    ]);
    expect(approved.events[1].actor.userId).toBe(u.mgr.id);
    await as(u.mgr)
      .post(bUrl(`${pending.id}/approve`))
      .expect(409);
    await as(u.mgr)
      .post(bUrl(`${pending.id}/complete`))
      .expect(409);

    const other = (
      await book(u.neighbour, 'U2', { facilityId: hall, startsAt: at(9, '18:00') }).expect(201)
    ).body.booking;
    await as(u.mgr)
      .post(bUrl(`${other.id}/reject`))
      .send({})
      .expect(400);
    const rejected = (
      await as(u.mgr)
        .post(bUrl(`${other.id}/reject`))
        .send({ reason: 'Private event' })
        .expect(200)
    ).body.booking;
    expect(rejected).toMatchObject({ status: 'REJECTED', statusNote: 'Private event' });
    const seen = (
      await as(u.neighbour)
        .get(`${pUrl()}/units/${units.U2}/facility-bookings/${other.id}`)
        .expect(200)
    ).body.booking;
    expect(seen.statusNote).toBe('Private event');
  });
});

describe('closures', () => {
  it('refuse to cover bookings unless told to cancel them, and block booking until lifted', async () => {
    const b = (
      await book(u.tenant, 'U1', { facilityId: pool, startsAt: at(10, '10:00') }).expect(201)
    ).body.booking;
    const closure = { startsAt: at(10, '06:00'), endsAt: at(10, '22:00'), reason: 'Pump repair' };
    const refused = await as(u.mgr)
      .post(fUrl(`${pool}/closures`))
      .send(closure)
      .expect(409);
    expect(refused.body.error.code).toBe('BOOKINGS_IN_THE_WAY');
    const closed = (
      await as(u.mgr)
        .post(fUrl(`${pool}/closures`))
        .send({ ...closure, cancelBookings: true })
        .expect(201)
    ).body;
    expect(closed.closures).toHaveLength(1);
    const cancelled = (
      await as(u.tenant)
        .get(unitUrl('U1', `facility-bookings/${b.id}`))
        .expect(200)
    ).body.booking;
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      statusNote: 'Facility closed: Pump repair',
    });

    const day = (
      await as(u.tenant).get(unitUrl('U1', `facilities/${pool}/availability?date=${localDate(10)}`))
    ).body.slots;
    expect(day.every((s: { state: string }) => s.state === 'CLOSED')).toBe(true);
    const res = await book(u.tenant, 'U1', { facilityId: pool, startsAt: at(10, '12:00') }).expect(
      409,
    );
    expect(res.body.error.code).toBe('FACILITY_CLOSED');

    await as(u.mgr)
      .post(fUrl(`${pool}/closures/${closed.closures[0].id}/lift`))
      .expect(200);
    await as(u.mgr)
      .post(fUrl(`${pool}/closures/${closed.closures[0].id}/lift`))
      .expect(409);
    await book(u.tenant, 'U1', { facilityId: pool, startsAt: at(10, '12:00') }).expect(201);
  });
});

describe('archiving', () => {
  it('needs nothing upcoming, then hides the facility from residents', async () => {
    const court = (
      await as(u.mgr)
        .post(fUrl())
        .send({
          commonAreaId: areas.Court,
          slotMinutes: 60,
          openingHours: everyDay('08:00', '20:00'),
        })
        .expect(201)
    ).body.facility.id;
    const b = (
      await book(u.neighbour, 'U2', { facilityId: court, startsAt: at(2, '09:00') }).expect(201)
    ).body.booking;
    expect(
      (
        await as(u.mgr)
          .post(fUrl(`${court}/archive`))
          .expect(409)
      ).body.error.code,
    ).toBe('BOOKINGS_IN_THE_WAY');
    await as(u.neighbour)
      .post(`${pUrl()}/units/${units.U2}/facility-bookings/${b.id}/cancel`)
      .send({})
      .expect(200);
    const archived = (
      await as(u.mgr)
        .post(fUrl(`${court}/archive`))
        .expect(200)
    ).body.facility;
    expect(archived.status).toBe('ARCHIVED');
    await as(u.mgr).patch(fUrl(court)).send({ capacity: 3 }).expect(409);
    const list = (await as(u.tenant).get(unitUrl('U1', 'facilities')).expect(200)).body.data;
    expect(list.map((f: { name: string }) => f.name)).not.toContain('Court');
    await as(u.tenant)
      .get(unitUrl('U1', `facilities/${court}/availability?date=${localDate(2)}`))
      .expect(404);
  });
});

describe('fees and deposits', () => {
  const finUrl = (path: string) => `${pUrl()}/finance/${path}`;
  let studio: string;
  let types: Record<string, string>;

  /** Test setup only: moves a booking into the past without the triggers, as the superuser. */
  async function backdate(id: string) {
    const su = new pg.Pool({ connectionString: inject('superuserDatabaseUrl'), max: 1 });
    try {
      const c = await su.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(
          `UPDATE facility_bookings SET starts_at = now() - interval '2 hours',
                  ends_at = now() - interval '1 hour' WHERE id = $1`,
          [id],
        );
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    } finally {
      await su.end();
    }
  }

  const invoice = async (id: string) =>
    (
      await as(u.admin)
        .get(finUrl(`invoices/${id}`))
        .expect(200)
    ).body;

  beforeAll(async () => {
    await as(u.admin).post(finUrl('setup')).expect(200);
    const list = (await as(u.admin).get(finUrl('charge-types')).expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    types = Object.fromEntries(list.map((t) => [t.code, t.id]));
    expect(types.FACILITY && types.DEPOSIT).toBeTruthy();
    const area = (
      await as(u.admin)
        .post(`${pUrl()}/common-areas`)
        .send({ name: 'Studio', type: 'FUNCTION_ROOM' })
        .expect(201)
    ).body.id;
    // A fee must book to income and a deposit to a liability.
    await as(u.mgr)
      .post(fUrl())
      .send({
        commonAreaId: area,
        slotMinutes: 60,
        depositChargeTypeId: types.FACILITY,
        deposit: '2000.00',
      })
      .expect(422);
    await as(u.mgr)
      .post(fUrl())
      .send({ commonAreaId: area, slotMinutes: 60, feeChargeTypeId: types.FACILITY })
      .expect(422);
    const created = await as(u.mgr)
      .post(fUrl())
      .send({
        commonAreaId: area,
        slotMinutes: 60,
        maxSlotsPerBooking: 3,
        feeChargeTypeId: types.FACILITY,
        feePerSlot: '500.00',
        depositChargeTypeId: types.DEPOSIT,
        deposit: '2000.00',
        openingHours: everyDay('08:00', '22:00'),
      })
      .expect(201);
    studio = created.body.facility.id;
    expect(created.body.facility.fee.perSlot).toEqual({ amountMinor: '50000', currency: 'PKR' });
    expect(created.body.facility.deposit.amount).toEqual({
      amountMinor: '200000',
      currency: 'PKR',
    });
  });

  it('invoice the unit when confirmed, and credit what is unpaid when cancelled', async () => {
    const booked = (
      await book(u.tenant, 'U1', {
        facilityId: studio,
        startsAt: at(11, '10:00'),
        slots: 2,
      }).expect(201)
    ).body.booking;
    expect(booked).toMatchObject({
      status: 'CONFIRMED',
      fee: { amountMinor: '100000', currency: 'PKR' },
      deposit: { amountMinor: '200000', currency: 'PKR' },
    });
    expect(booked.invoiceId).toBeTruthy();
    const issued = await invoice(booked.invoiceId);
    expect(issued).toMatchObject({
      status: 'ISSUED',
      billTo: 'TENANTS',
      total: { amountMinor: '300000' },
      outstanding: { amountMinor: '300000' },
    });
    expect(issued.lines.map((l: { description: string }) => l.description)).toEqual([
      `Studio booking ${booked.number} (2 slots)`,
      `Studio deposit ${booked.number}`,
    ]);

    const cancelled = (
      await as(u.tenant)
        .post(unitUrl('U1', `facility-bookings/${booked.id}/cancel`))
        .send({})
        .expect(200)
    ).body.booking;
    expect(cancelled.depositReleasedAt).not.toBeNull();
    const credited = await invoice(booked.invoiceId);
    expect(credited.credited.amountMinor).toBe('300000');
    expect(credited.outstanding.amountMinor).toBe('0');
  });

  it('wait for approval before charging, and release the deposit after use, once', async () => {
    await as(u.mgr).patch(fUrl(studio)).send({ approvalRequired: true }).expect(200);
    const pending = (
      await book(u.neighbour, 'U2', { facilityId: studio, startsAt: at(12, '10:00') }).expect(201)
    ).body.booking;
    expect(pending).toMatchObject({ status: 'PENDING', invoiceId: null });
    const approved = (
      await as(u.mgr)
        .post(bUrl(`${pending.id}/approve`))
        .expect(200)
    ).body.booking;
    expect(approved.invoiceId).toBeTruthy();
    // The unit has an owner and no tenancy: billed to the owners.
    expect((await invoice(approved.invoiceId)).billTo).toBe('OWNERS');

    await as(u.mgr)
      .post(bUrl(`${pending.id}/release-deposit`))
      .expect(409);
    await backdate(pending.id);
    await as(u.mgr)
      .post(bUrl(`${pending.id}/complete`))
      .expect(200);
    await as(u.neighbour)
      .post(`${pUrl()}/units/${units.U2}/facility-bookings/${pending.id}/cancel`)
      .send({})
      .expect(409);
    const released = (
      await as(u.mgr)
        .post(bUrl(`${pending.id}/release-deposit`))
        .expect(200)
    ).body.booking;
    expect(released.depositReleasedAt).not.toBeNull();
    await as(u.mgr)
      .post(bUrl(`${pending.id}/release-deposit`))
      .expect(409);
    const after = await invoice(approved.invoiceId);
    expect(after.credited.amountMinor).toBe('200000');
    expect(after.outstanding.amountMinor).toBe('50000');
    await as(u.mgr).patch(fUrl(studio)).send({ approvalRequired: false }).expect(200);
  });

  it('rejecting a pending booking charges nothing', async () => {
    await as(u.mgr).patch(fUrl(studio)).send({ approvalRequired: true }).expect(200);
    const pending = (
      await book(u.tenant, 'U1', { facilityId: studio, startsAt: at(13, '10:00') }).expect(201)
    ).body.booking;
    const rejected = (
      await as(u.mgr)
        .post(bUrl(`${pending.id}/reject`))
        .send({ reason: 'Booked out' })
        .expect(200)
    ).body.booking;
    expect(rejected).toMatchObject({ status: 'REJECTED', invoiceId: null });
  });
});

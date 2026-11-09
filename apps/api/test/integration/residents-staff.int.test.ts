import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadApiEnv } from '../../src/platform/config/env';
import { REDIS_CLIENT } from '../../src/platform/infrastructure/infrastructure.module';
import { RATE_LIMITER } from '../../src/platform/rate-limit/rate-limiter';
import { InMemoryRateLimiter } from '../support/in-memory-rate-limiter';

/**
 * Staff management of residents over HTTP against the real database: profiles, ownership
 * (first owner, transfer, voiding), tenancies (move-in/out), household, vehicles, emergency
 * contacts, the occupancy guard on archiving, and who may do what.
 */

const PASSWORD = 'correct horse battery staple';
let app: INestApplication;
const limiter = new InMemoryRateLimiter();
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
  delete: (url: string) => http().delete(url).set('Cookie', user.cookie),
});

let admin: TestUser;
let manager: TestUser; // property manager of P
let otherManager: TestUser; // property manager of Q
let finance: TestUser;
let org: string;
let P: string;
let Q: string;
const units: Record<string, string> = {};
const orgUrl = () => `/api/v1/organisations/${org}`;
const pUrl = (property = P) => `${orgUrl()}/properties/${property}`;
const uUrl = (unit: string, property = P) => `${pUrl(property)}/units/${units[unit]}`;

async function person(name: string, user = manager, property = P): Promise<string> {
  const res = await as(user)
    .post(`${pUrl(property)}/persons`)
    .send({
      fullName: `${name} Resident`,
      email: `${name}-${run}@example.test`,
      phone: '+92 300 1234567',
    })
    .expect(201);
  return res.body.id;
}

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
    .useValue(limiter)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, env);
  await app.init();

  [admin, manager, otherManager, finance] = (await Promise.all(
    ['admin', 'manager', 'other', 'finance'].map(signUp),
  )) as [TestUser, TestUser, TestUser, TestUser];
  org = (
    await as(admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Residents Org',
        slug: `res-staff-${run}`,
        countryCode: 'PK',
        defaultCurrency: 'PKR',
        defaultTimeZone: 'Asia/Karachi',
      })
      .expect(201)
  ).body.id;
  const property = async (code: string) =>
    (
      await as(admin)
        .post(`${orgUrl()}/properties`)
        .send({
          name: `Residence ${code}`,
          code,
          type: 'CONDOMINIUM',
          addressLine1: '1 Road',
          city: 'Karachi',
        })
        .expect(201)
    ).body.id as string;
  P = await property('PP');
  Q = await property('QQ');
  for (const [user, role, propertyId] of [
    [manager, 'PROPERTY_MANAGER', P],
    [otherManager, 'PROPERTY_MANAGER', Q],
    [finance, 'FINANCE_OFFICER', undefined],
  ] as const) {
    const invited = await as(admin)
      .post(`${orgUrl()}/invitations`)
      .send({ email: user.email, role, ...(propertyId ? { propertyId } : {}) })
      .expect(201);
    await as(user)
      .post('/api/v1/invitations/accept')
      .send({ token: invited.body.token })
      .expect(200);
  }
  for (const number of ['U1', 'U2', 'U3', 'U4', 'U5']) {
    units[number] = (
      await as(admin).post(`${pUrl()}/units`).send({ number, type: 'APARTMENT' }).expect(201)
    ).body.id;
  }
  units.Q1 = (
    await as(admin)
      .post(`${pUrl(Q)}/units`)
      .send({ number: 'Q1', type: 'APARTMENT' })
      .expect(201)
  ).body.id;
});

afterAll(async () => {
  await app?.close();
});

describe('resident profiles', () => {
  it('lets a property manager create and edit a profile, with normalised contact data', async () => {
    const id = await person('ann');
    const shown = await as(manager).get(`${pUrl()}/persons/${id}`).expect(200);
    expect(shown.body.person).toMatchObject({
      fullName: 'ann Resident',
      phone: '+923001234567',
      linked: false,
    });
    const updated = await as(manager)
      .patch(`${pUrl()}/persons/${id}`)
      .send({ phone: null, preferredLanguage: 'ur-PK' })
      .expect(200);
    expect(updated.body).toMatchObject({ phone: null, preferredLanguage: 'ur-PK' });
  });

  it('rejects a duplicate email and invalid contact data', async () => {
    await person('dup');
    const res = await as(manager)
      .post(`${pUrl()}/persons`)
      .send({ fullName: 'Copy', email: `DUP-${run}@example.test` })
      .expect(409);
    expect(res.body.error.code).toBe('PERSON_EMAIL_TAKEN');
    await as(manager)
      .post(`${pUrl()}/persons`)
      .send({ fullName: 'Bad', phone: '0300' })
      .expect(400);
  });

  it('hides people of other properties from a property manager; admins use the directory', async () => {
    const qPerson = await person('quinn', otherManager, Q);
    await as(otherManager)
      .post(`${uUrl('Q1', Q)}/owners`)
      .send({
        effectiveFrom: '2026-01-01',
        owners: [{ personId: qPerson, shareNumerator: 1, shareDenominator: 1 }],
      })
      .expect(200);
    await as(manager).get(`${pUrl()}/persons/${qPerson}`).expect(404);
    await as(manager)
      .patch(`${pUrl()}/persons/${qPerson}`)
      .send({ fullName: 'Taken over' })
      .expect(404);

    const found = await as(admin).get(`${orgUrl()}/persons?query=quinn`).expect(200);
    expect(found.body.data.map((p: { id: string }) => p.id)).toEqual([qPerson]);
    await as(admin).get(`${orgUrl()}/persons/${qPerson}`).expect(200);
    await as(manager).get(`${orgUrl()}/persons`).expect(403);
  });

  it('keeps contact details away from finance officers', async () => {
    await as(finance).get(`${pUrl()}/residents`).expect(403);
  });

  it('adds and removes emergency contacts', async () => {
    const id = await person('erin');
    const added = await as(manager)
      .post(`${pUrl()}/persons/${id}/emergency-contacts`)
      .send({ name: 'Dad', phone: '+923009998887', relationship: 'Father' })
      .expect(201);
    await as(manager)
      .delete(`${pUrl()}/persons/${id}/emergency-contacts/${added.body.id}`)
      .expect(204);
    await as(manager)
      .delete(`${pUrl()}/persons/${id}/emergency-contacts/${added.body.id}`)
      .expect(404);
  });
});

describe('ownership', () => {
  let ann: string;
  let ben: string;

  it('records a first owner and transfers to co-owners in one step', async () => {
    ann = await person('owner-ann');
    ben = await person('owner-ben');
    await as(manager)
      .post(`${uUrl('U1')}/owners`)
      .send({
        effectiveFrom: '2025-01-01',
        owners: [{ personId: ann, shareNumerator: 1, shareDenominator: 1 }],
      })
      .expect(200);
    const res = await as(manager)
      .post(`${uUrl('U1')}/owners`)
      .send({
        effectiveFrom: '2026-01-01',
        owners: [
          { personId: ann, shareNumerator: 1, shareDenominator: 2 },
          { personId: ben, shareNumerator: 1, shareDenominator: 2 },
        ],
      })
      .expect(200);
    expect(
      res.body.data.map(
        (o: {
          fullName: string;
          effectiveFrom: string;
          effectiveTo: string | null;
          shareDenominator: number;
        }) => [o.fullName, o.effectiveFrom, o.effectiveTo, o.shareDenominator],
      ),
    ).toEqual([
      ['owner-ann Resident', '2025-01-01', '2025-12-31', 1],
      ['owner-ann Resident', '2026-01-01', null, 2],
      ['owner-ben Resident', '2026-01-01', null, 2],
    ]);
  });

  it('refuses shares that do not add up, and rewriting history', async () => {
    await as(manager)
      .post(`${uUrl('U1')}/owners`)
      .send({
        effectiveFrom: '2027-01-01',
        owners: [
          { personId: ann, shareNumerator: 1, shareDenominator: 2 },
          { personId: ben, shareNumerator: 1, shareDenominator: 3 },
        ],
      })
      .expect(400);
    const res = await as(manager)
      .post(`${uUrl('U1')}/owners`)
      .send({
        effectiveFrom: '2025-06-01',
        owners: [{ personId: ben, shareNumerator: 1, shareDenominator: 1 }],
      })
      .expect(409);
    expect(res.body.error.code).toBe('OWNERSHIP_CONFLICT');
  });

  it('refuses voiding one co-owner (shares would no longer add up), allows voiding both', async () => {
    const history = (
      await as(manager)
        .get(`${uUrl('U1')}/ownerships`)
        .expect(200)
    ).body.data as { id: string; effectiveTo: string | null }[];
    const current = history.filter((o) => o.effectiveTo === null).map((o) => o.id);
    const one = await as(manager)
      .post(`${uUrl('U1')}/ownerships/void`)
      .send({ ownershipIds: [current[0]], reason: 'Entered by mistake' })
      .expect(409);
    expect(one.body.error.code).toBe('RESIDENCY_RULE_VIOLATED');
    const both = await as(manager)
      .post(`${uUrl('U1')}/ownerships/void`)
      .send({ ownershipIds: current, reason: 'Entered by mistake' })
      .expect(200);
    expect(
      both.body.data.filter(
        (o: { voidReason: string | null }) => o.voidReason === 'Entered by mistake',
      ),
    ).toHaveLength(2);
  });
});

describe('tenancies and household', () => {
  it('handles move-in, overlap, move-out and voiding', async () => {
    const tia = await person('tia');
    const tim = await person('tim');
    const created = await as(manager)
      .post(`${uUrl('U2')}/tenancies`)
      .send({
        startDate: '2026-01-01',
        occupants: [{ personId: tia, isPrimary: true }, { personId: tim }],
      })
      .expect(201);
    expect(created.body.occupants.map((o: { isPrimary: boolean }) => o.isPrimary)).toEqual([
      true,
      false,
    ]);

    const overlap = await as(manager)
      .post(`${uUrl('U2')}/tenancies`)
      .send({ startDate: '2026-06-01', occupants: [{ personId: tim, isPrimary: true }] })
      .expect(409);
    expect(overlap.body.error.code).toBe('TENANCY_OVERLAP');
    await as(manager)
      .post(`${uUrl('U2')}/tenancies`)
      .send({ startDate: '2026-06-01', occupants: [{ personId: tim }] })
      .expect(400);

    const ended = await as(manager)
      .post(`${uUrl('U2')}/tenancies/${created.body.id}/end`)
      .send({ endDate: '2026-05-31' })
      .expect(200);
    expect(ended.body.endDate).toBe('2026-05-31');
    await as(manager)
      .post(`${uUrl('U2')}/tenancies/${created.body.id}/end`)
      .send({ endDate: '2025-12-31' })
      .expect(422);
    await as(manager)
      .post(`${uUrl('U2')}/tenancies`)
      .send({ startDate: '2026-06-01', occupants: [{ personId: tim, isPrimary: true }] })
      .expect(201);

    const voided = await as(manager)
      .post(`${uUrl('U2')}/tenancies/${created.body.id}/void`)
      .send({ reason: 'Wrong unit' })
      .expect(200);
    expect(voided.body.voidReason).toBe('Wrong unit');
  });

  it('adds, ends and voids household members without overlaps', async () => {
    const kid = await person('kid');
    const added = await as(manager)
      .post(`${uUrl('U3')}/household`)
      .send({ personId: kid, relationship: 'CHILD', validFrom: '2026-01-01' })
      .expect(201);
    const overlap = await as(manager)
      .post(`${uUrl('U3')}/household`)
      .send({ personId: kid, relationship: 'CHILD', validFrom: '2026-03-01' })
      .expect(409);
    expect(overlap.body.error.code).toBe('HOUSEHOLD_OVERLAP');
    await as(manager)
      .post(`${uUrl('U3')}/household/${added.body.id}/end`)
      .send({ endDate: '2026-02-28' })
      .expect(200);
    await as(manager)
      .post(`${uUrl('U3')}/household`)
      .send({ personId: kid, relationship: 'CHILD', validFrom: '2026-03-01' })
      .expect(201);
    await as(manager)
      .post(`${uUrl('U3')}/household/${added.body.id}/void`)
      .expect(200);
  });
});

describe('vehicles', () => {
  it('normalises plates, keeps them unique per property, frees them on archive', async () => {
    const first = await as(manager)
      .post(`${pUrl()}/vehicles`)
      .send({ plate: 'lea 1234', unitId: units.U1, make: 'Toyota' })
      .expect(201);
    expect(first.body.plate).toBe('LEA1234');
    const dup = await as(manager)
      .post(`${pUrl()}/vehicles`)
      .send({ plate: 'LEA1234', unitId: units.U2 })
      .expect(409);
    expect(dup.body.error.code).toBe('PLATE_TAKEN');
    await as(manager).post(`${pUrl()}/vehicles/${first.body.id}/archive`).expect(200);
    await as(manager)
      .post(`${pUrl()}/vehicles`)
      .send({ plate: 'LEA1234', unitId: units.U2 })
      .expect(201);
    // A unit of another property is not found through this property.
    await as(manager)
      .post(`${pUrl()}/vehicles`)
      .send({ plate: 'XYZ9', unitId: units.Q1 })
      .expect(404);
  });
});

describe('archiving is refused while a unit is occupied', () => {
  it('refuses a unit with current or future records and allows it once they have ended', async () => {
    const owner = await person('archive-owner');
    await as(manager)
      .post(`${uUrl('U4')}/owners`)
      .send({
        effectiveFrom: '2024-01-01',
        owners: [{ personId: owner, shareNumerator: 1, shareDenominator: 1 }],
      })
      .expect(200);
    const res = await as(admin)
      .post(`${uUrl('U4')}/archive`)
      .expect(409);
    expect(res.body.error.code).toBe('UNIT_OCCUPIED');

    const tenant = await person('future-tenant');
    await as(manager)
      .post(`${uUrl('U5')}/tenancies`)
      .send({ startDate: '2099-01-01', occupants: [{ personId: tenant, isPrimary: true }] })
      .expect(201);
    expect(
      (
        await as(admin)
          .post(`${uUrl('U5')}/archive`)
          .expect(409)
      ).body.error.code,
    ).toBe('UNIT_OCCUPIED');
  });

  it('refuses archiving a property with occupied units', async () => {
    const res = await as(admin).post(`${pUrl()}/archive`).expect(409);
    expect(res.body.error.code).toBe('PROPERTY_OCCUPIED');
  });

  it('refuses resident changes on an archived unit', async () => {
    const empty = (
      await as(admin).post(`${pUrl()}/units`).send({ number: 'EMPTY', type: 'STUDIO' }).expect(201)
    ).body.id;
    await as(admin).post(`${pUrl()}/units/${empty}/archive`).expect(200);
    const someone = await person('late');
    const res = await as(manager)
      .post(`${pUrl()}/units/${empty}/owners`)
      .send({
        effectiveFrom: '2026-01-01',
        owners: [{ personId: someone, shareNumerator: 1, shareDenominator: 1 }],
      })
      .expect(409);
    expect(res.body.error.code).toBe('ARCHIVED');
  });
});

describe('scope', () => {
  it('lists current residents of the property with their roles', async () => {
    const res = await as(manager).get(`${pUrl()}/residents`).expect(200);
    const rows = res.body.data as {
      person: { fullName: string };
      units: { unitNumber: string; roles: string[] }[];
    }[];
    expect(rows.find((r) => r.person.fullName === 'archive-owner Resident')?.units).toEqual([
      expect.objectContaining({ unitNumber: 'U4', roles: ['OWNER'] }),
    ]);
    expect(rows.find((r) => r.person.fullName === 'quinn Resident')).toBeUndefined();
  });

  it("refuses another property's manager and outsiders", async () => {
    await as(otherManager).get(`${pUrl()}/residents`).expect(404);
    await as(otherManager)
      .post(`${uUrl('U1')}/owners`)
      .send({
        effectiveFrom: '2030-01-01',
        owners: [{ personId: randomUUID(), shareNumerator: 1, shareDenominator: 1 }],
      })
      .expect(404);
    const outsider = await signUp('outsider');
    await as(outsider).get(`${pUrl()}/residents`).expect(404);
  });
});

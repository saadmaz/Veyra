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
 * Resident access over HTTP against the real database: linking profiles to logins through
 * resident invitations, and owner / tenant / household access derived from records that are
 * effective TODAY IN THE PROPERTY'S TIME ZONE.
 */

const PASSWORD = 'correct horse battery staple';
/**
 * A zone whose local date differs from the UTC date right now, so a UTC-based implementation
 * would fail: from 10:00 UTC, Kiritimati (UTC+14) is already on the next day; before 10:00 UTC,
 * Pago Pago (UTC-11) is still on the previous day.
 */
const ZONE = new Date().getUTCHours() >= 10 ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago';
let app: INestApplication;
let db: pg.Pool;
const limiter = new InMemoryRateLimiter();
const run = randomUUID().slice(0, 8);
const http = () => request(app.getHttpServer());

/** YYYY-MM-DD in the property's zone, shifted by whole days. */
function localDate(offsetDays = 0): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

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
});

/** Test fixtures written as the application role inside the tenant (Part 3 adds the API). */
async function sql(organisationId: string, text: string, params: unknown[] = []) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [organisationId]);
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

let admin: TestUser;
let finance: TestUser;
let org: string;
let otherOrg: string;
let property: string;
const units: Record<string, string> = {};
const people: Record<string, { personId: string; user?: TestUser }> = {};

async function createPerson(name: string, withEmail = true): Promise<string> {
  const personId = randomUUID();
  await sql(
    org,
    `INSERT INTO persons (id, organisation_id, full_name, email, updated_at) VALUES ($1, $2, $3, $4, now())`,
    [
      personId,
      org,
      `${name[0]?.toUpperCase()}${name.slice(1)} Resident`,
      withEmail ? `${name}-${run}@example.test` : null,
    ],
  );
  return personId;
}

async function link(name: string): Promise<TestUser> {
  const person = people[name] as { personId: string };
  const user = await signUp(name);
  const invited = await as(admin)
    .post(`/api/v1/organisations/${org}/persons/${person.personId}/invitations`)
    .expect(201);
  expect(invited.body.invitation).toMatchObject({ role: 'RESIDENT', email: user.email });
  const accepted = await as(user)
    .post('/api/v1/invitations/accept')
    .send({ token: invited.body.token })
    .expect(200);
  expect(accepted.body.role).toBe('RESIDENT');
  people[name] = { ...person, user };
  return user;
}

const unitUrl = (unit: string) =>
  `/api/v1/organisations/${org}/properties/${property}/units/${units[unit]}`;
const userOf = (name: string) => people[name]?.user as TestUser;

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
  db = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 2 });

  admin = await signUp('admin');
  finance = await signUp('finance');
  const outsider = await signUp('outsider');
  const newOrg = (user: TestUser, slug: string) =>
    as(user)
      .post('/api/v1/organisations')
      .send({
        name: slug,
        slug: `${slug}-${run}`,
        countryCode: 'KI',
        defaultCurrency: 'AUD',
        defaultTimeZone: ZONE,
      })
      .expect(201)
      .then((res) => res.body.id as string);
  org = await newOrg(admin, 'res-org');
  otherOrg = await newOrg(outsider, 'res-other');
  const fin = await as(admin)
    .post(`/api/v1/organisations/${org}/invitations`)
    .send({ email: finance.email, role: 'FINANCE_OFFICER' })
    .expect(201);
  await as(finance).post('/api/v1/invitations/accept').send({ token: fin.body.token }).expect(200);

  property = (
    await as(admin)
      .post(`/api/v1/organisations/${org}/properties`)
      .send({
        name: 'Lagoon Court',
        code: 'LGN',
        type: 'CONDOMINIUM',
        addressLine1: '1 Lagoon Road',
        city: 'London',
      })
      .expect(201)
  ).body.id;
  for (const number of ['U1', 'U2', 'U3', 'U4']) {
    units[number] = (
      await as(admin)
        .post(`/api/v1/organisations/${org}/properties/${property}/units`)
        .send({ number, type: 'APARTMENT' })
        .expect(201)
    ).body.id;
  }

  for (const name of ['ann', 'hal', 'tom', 'eve', 'fay', 'noemail']) {
    people[name] = { personId: await createPerson(name, name !== 'noemail') };
  }
  const p = (name: string) => (people[name] as { personId: string }).personId;
  // Ann owns U1 since last year; Hal lives in U1 as household; Tom rents U2 from TODAY (local);
  // Eve owned U4 until YESTERDAY (local); Fay's tenancy of U3 starts TOMORROW (local).
  await sql(
    org,
    `INSERT INTO ownerships (id, organisation_id, property_id, unit_id, person_id, share_numerator, share_denominator, effective_from, updated_at) VALUES ($1, $2, $3, $4, $5, 1, 1, $6, now())`,
    [randomUUID(), org, property, units.U1, p('ann'), localDate(-365)],
  );
  await sql(
    org,
    `INSERT INTO household_members (id, organisation_id, property_id, unit_id, person_id, relationship, valid_from, updated_at) VALUES ($1, $2, $3, $4, $5, 'CHILD', $6, now())`,
    [randomUUID(), org, property, units.U1, p('hal'), localDate(-30)],
  );
  await sql(
    org,
    `INSERT INTO ownerships (id, organisation_id, property_id, unit_id, person_id, share_numerator, share_denominator, effective_from, effective_to, updated_at) VALUES ($1, $2, $3, $4, $5, 1, 1, $6, $7, now())`,
    [randomUUID(), org, property, units.U4, p('eve'), localDate(-365), localDate(-1)],
  );
  for (const [unit, name, start] of [
    ['U2', 'tom', localDate(0)],
    ['U3', 'fay', localDate(1)],
  ] as const) {
    const tenancy = randomUUID();
    await sql(
      org,
      `INSERT INTO tenancies (id, organisation_id, property_id, unit_id, start_date, updated_at) VALUES ($1, $2, $3, $4, $5, now())`,
      [tenancy, org, property, units[unit], start],
    );
    await sql(
      org,
      `INSERT INTO tenancy_occupants (id, organisation_id, tenancy_id, person_id, is_primary) VALUES ($1, $2, $3, $4, true)`,
      [randomUUID(), org, tenancy, p(name)],
    );
  }
  for (const name of ['ann', 'hal', 'tom', 'eve', 'fay']) await link(name);
});

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe('an owner', () => {
  it('appears as an owner of the organisation, with only the baseline organisation permission', async () => {
    const mine = await as(userOf('ann')).get('/api/v1/organisations').expect(200);
    expect(mine.body.data).toEqual([
      { organisation: expect.objectContaining({ id: org }), roles: ['OWNER'] },
    ]);
    const detail = await as(userOf('ann')).get(`/api/v1/organisations/${org}`).expect(200);
    expect(detail.body.permissions).toEqual(['organisation.profile.read']);
    await as(userOf('ann')).get(`/api/v1/organisations/${org}/memberships`).expect(403);
  });

  it('sees their unit and its residents, and nothing else', async () => {
    const myUnits = await as(userOf('ann'))
      .get(`/api/v1/organisations/${org}/my-units`)
      .expect(200);
    expect(myUnits.body.data).toEqual([
      expect.objectContaining({
        unitId: units.U1,
        unitNumber: 'U1',
        propertyName: 'Lagoon Court',
        roles: ['OWNER'],
      }),
    ]);
    const unit = await as(userOf('ann')).get(unitUrl('U1')).expect(200);
    expect(unit.body).toMatchObject({ unitNumber: 'U1', myRoles: ['OWNER'] });
    const residents = await as(userOf('ann'))
      .get(`${unitUrl('U1')}/residents`)
      .expect(200);
    expect(residents.body.owners).toEqual([
      expect.objectContaining({ fullName: 'Ann Resident', shareNumerator: 1, shareDenominator: 1 }),
    ]);
    expect(residents.body.household).toEqual([
      expect.objectContaining({ fullName: 'Hal Resident', relationship: 'CHILD' }),
    ]);
    expect(JSON.stringify(residents.body)).not.toMatch(/@example\.test/);

    await as(userOf('ann')).get(unitUrl('U2')).expect(404);
    await as(userOf('ann')).get(`/api/v1/organisations/${org}/properties/${property}`).expect(404);
    await as(userOf('ann')).get(`/api/v1/organisations/${otherOrg}`).expect(404);
  });
});

describe('a household member', () => {
  it('sees the unit but not the list of residents', async () => {
    await as(userOf('hal')).get(unitUrl('U1')).expect(200);
    const res = await as(userOf('hal'))
      .get(`${unitUrl('U1')}/residents`)
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('dates follow the property’s local calendar', () => {
  it('uses a zone whose date differs from UTC today (so this test can catch UTC mistakes)', () => {
    expect(localDate(0)).not.toBe(new Date().toISOString().slice(0, 10));
  });

  it('gives a tenant access from the first local day of the tenancy', async () => {
    const unit = await as(userOf('tom')).get(unitUrl('U2')).expect(200);
    expect(unit.body.myRoles).toEqual(['TENANT']);
  });

  it('gives nothing before a tenancy starts or after an ownership ends', async () => {
    await as(userOf('fay')).get(unitUrl('U3')).expect(404);
    await as(userOf('eve')).get(unitUrl('U4')).expect(404);
    // Linked but with no current record: not an effective member of the organisation either.
    await as(userOf('eve')).get(`/api/v1/organisations/${org}`).expect(404);
    expect((await as(userOf('eve')).get('/api/v1/organisations').expect(200)).body.data).toEqual(
      [],
    );
  });

  it('ends access on the next request when the tenancy ends', async () => {
    await sql(org, `UPDATE tenancies SET start_date = $2, end_date = $3 WHERE unit_id = $1`, [
      units.U2,
      localDate(-10),
      localDate(-1),
    ]);
    await as(userOf('tom')).get(unitUrl('U2')).expect(404);
  });

  it('ends access when the record is voided or the profile archived', async () => {
    const hal = userOf('hal');
    await sql(org, `UPDATE household_members SET voided_at = now() WHERE unit_id = $1`, [units.U1]);
    await as(hal).get(unitUrl('U1')).expect(404);
  });
});

describe('staff', () => {
  it('see residents through their organisation grant; finance officers do not see names', async () => {
    const res = await as(admin)
      .get(`${unitUrl('U1')}/residents`)
      .expect(200);
    expect(res.body.owners).toHaveLength(1);
    const unit = await as(admin).get(unitUrl('U1')).expect(200);
    expect(unit.body.myRoles).toEqual([]);
    await as(finance).get(unitUrl('U1')).expect(200);
    await as(finance)
      .get(`${unitUrl('U1')}/residents`)
      .expect(403);
  });
});

describe('resident invitations', () => {
  it('cannot be created for a profile without email, an already linked profile, or another organisation', async () => {
    const noEmail = await as(admin)
      .post(`/api/v1/organisations/${org}/persons/${people.noemail?.personId}/invitations`)
      .expect(422);
    expect(noEmail.body.error.code).toBe('PERSON_HAS_NO_EMAIL');
    const linked = await as(admin)
      .post(`/api/v1/organisations/${org}/persons/${people.ann?.personId}/invitations`)
      .expect(409);
    expect(linked.body.error.code).toBe('PERSON_ALREADY_LINKED');
    await as(admin)
      .post(`/api/v1/organisations/${org}/persons/${randomUUID()}/invitations`)
      .expect(404);
  });

  it('can only be accepted by the person the profile’s email belongs to', async () => {
    const gus = await createPerson('gus');
    const invited = await as(admin)
      .post(`/api/v1/organisations/${org}/persons/${gus}/invitations`)
      .expect(201);
    const res = await as(admin)
      .post('/api/v1/invitations/accept')
      .send({ token: invited.body.token })
      .expect(403);
    expect(res.body.error.code).toBe('INVITATION_EMAIL_MISMATCH');
  });

  it('never grants a derived role by invitation', async () => {
    const res = await as(admin)
      .post(`/api/v1/organisations/${org}/invitations`)
      .send({ email: `x-${run}@example.test`, role: 'OWNER' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('leaves an archived profile without access', async () => {
    const ann = userOf('ann');
    await sql(org, `UPDATE persons SET status = 'ARCHIVED', archived_at = now() WHERE id = $1`, [
      people.ann?.personId,
    ]);
    await as(ann).get(unitUrl('U1')).expect(404);
    expect((await as(ann).get('/api/v1/organisations').expect(200)).body.data).toEqual([]);
  });
});

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
 * Property settings, lifecycle and structure over HTTP against the real database: permissions
 * per role, archive rules and cascades, parent checks, unique rules, decimals as strings, and
 * create/archive races.
 */

const PASSWORD = 'correct horse battery staple';
let app: INestApplication;
let db: pg.Pool;
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
});

let admin: TestUser;
let manager: TestUser; // property manager of P only
let otherManager: TestUser; // property manager of Q only
let finance: TestUser; // organisation-wide finance officer
let outsider: TestUser; // admin of another organisation
let org: string;
let P: string;
let Q: string;
const base = () => `/api/v1/organisations/${org}/properties/${P}`;

async function createProperty(user: TestUser, code: string): Promise<string> {
  const res = await as(user)
    .post(`/api/v1/organisations/${org}/properties`)
    .send({
      name: `Residence ${code}`,
      code,
      type: 'APARTMENT_COMPLEX',
      addressLine1: '1 Main Road',
      city: 'Karachi',
    })
    .expect(201);
  return res.body.id;
}

async function invite(user: TestUser, role: string, propertyId?: string) {
  const res = await as(admin)
    .post(`/api/v1/organisations/${org}/invitations`)
    .send({ email: user.email, role, ...(propertyId ? { propertyId } : {}) })
    .expect(201);
  await as(user).post('/api/v1/invitations/accept').send({ token: res.body.token }).expect(200);
}

async function building(code: string, propertyBase = base(), user = admin): Promise<string> {
  const res = await as(user)
    .post(`${propertyBase}/buildings`)
    .send({ name: `Tower ${code}`, code })
    .expect(201);
  return res.body.id;
}

async function auditCount(action: string): Promise<number> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [org]);
    const { rows } = await client.query(
      'SELECT count(*)::int AS n FROM audit_logs WHERE action = $1',
      [action],
    );
    await client.query('COMMIT');
    return rows[0].n;
  } finally {
    client.release();
  }
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
  db = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 2 });

  [admin, manager, otherManager, finance, outsider] = (await Promise.all(
    ['admin', 'manager', 'other', 'finance', 'outsider'].map(signUp),
  )) as [TestUser, TestUser, TestUser, TestUser, TestUser];
  org = (
    await as(admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Structure Org',
        slug: `structure-${run}`,
        countryCode: 'PK',
        defaultCurrency: 'PKR',
        defaultTimeZone: 'Asia/Karachi',
      })
      .expect(201)
  ).body.id;
  await as(outsider)
    .post('/api/v1/organisations')
    .send({
      name: 'Other Org',
      slug: `structure-other-${run}`,
      countryCode: 'PK',
      defaultCurrency: 'PKR',
      defaultTimeZone: 'Asia/Karachi',
    })
    .expect(201);
  P = await createProperty(admin, 'PP');
  Q = await createProperty(admin, 'QQ');
  await invite(manager, 'PROPERTY_MANAGER', P);
  await invite(otherManager, 'PROPERTY_MANAGER', Q);
  await invite(finance, 'FINANCE_OFFICER');
});

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe('who may do what', () => {
  it('lets the property manager build the structure of their property', async () => {
    const id = await building('M1', base(), manager);
    await as(manager)
      .patch(`${base()}/buildings/${id}`)
      .send({ name: 'Tower M1 renamed' })
      .expect(200);
  });

  it('lets a finance officer read the structure but not change it', async () => {
    await as(finance).get(`${base()}/buildings`).expect(200);
    const res = await as(finance)
      .post(`${base()}/buildings`)
      .send({ name: 'X', code: 'X' })
      .expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it("hides a property's structure from the manager of another property and from outsiders", async () => {
    for (const user of [otherManager, outsider]) {
      await as(user).get(`${base()}/buildings`).expect(404);
      await as(user).post(`${base()}/units`).send({ number: '1', type: 'APARTMENT' }).expect(404);
    }
  });

  it('keeps lifecycle (activate/archive) with organisation admins', async () => {
    await as(manager).post(`${base()}/activate`).expect(403);
    await as(manager).post(`${base()}/archive`).expect(403);
    await as(manager).patch(base()).send({ name: 'Residence P (managed)' }).expect(200);
  });
});

describe('buildings and floors', () => {
  it('rejects a duplicate building code in the property, case-insensitively', async () => {
    await building('A');
    const res = await as(admin)
      .post(`${base()}/buildings`)
      .send({ name: 'Again', code: 'a' })
      .expect(409);
    expect(res.body.error.code).toBe('BUILDING_CODE_TAKEN');
    // The same code in another property is fine.
    await building('A', `/api/v1/organisations/${org}/properties/${Q}`);
  });

  it('keeps floor levels unique per building and floors inside their own building', async () => {
    const b = await building('FL');
    await as(admin)
      .post(`${base()}/buildings/${b}/floors`)
      .send({ level: 0, name: 'Ground' })
      .expect(201);
    const dup = await as(admin)
      .post(`${base()}/buildings/${b}/floors`)
      .send({ level: 0, name: 'Lobby' })
      .expect(409);
    expect(dup.body.error.code).toBe('FLOOR_LEVEL_TAKEN');

    const qBuilding = await building('QB', `/api/v1/organisations/${org}/properties/${Q}`);
    await as(admin)
      .post(`${base()}/buildings/${qBuilding}/floors`)
      .send({ level: 1, name: 'One' })
      .expect(404);
  });
});

describe('units', () => {
  it('stores area and share ratio as exact decimals, returned as strings', async () => {
    const b = await building('U1');
    const floor = (
      await as(admin)
        .post(`${base()}/buildings/${b}/floors`)
        .send({ level: 3, name: 'Third' })
        .expect(201)
    ).body.id;
    const res = await as(admin)
      .post(`${base()}/units`)
      .send({
        number: '3A',
        type: 'APARTMENT',
        buildingId: b,
        floorId: floor,
        areaSqm: '85.5',
        shareRatio: '0.012345',
      })
      .expect(201);
    expect(res.body).toMatchObject({
      areaSqm: '85.50',
      shareRatio: '0.012345',
      buildingId: b,
      floorId: floor,
    });

    const bad = await as(admin)
      .post(`${base()}/units`)
      .send({ number: '3B', type: 'APARTMENT', areaSqm: 85.5 })
      .expect(400);
    expect(bad.body.error.details[0].path).toBe('areaSqm');
  });

  it('rejects duplicate numbers per building and per property for building-less units', async () => {
    const b = await building('U2');
    await as(admin)
      .post(`${base()}/units`)
      .send({ number: '12B', type: 'APARTMENT', buildingId: b })
      .expect(201);
    const dup = await as(admin)
      .post(`${base()}/units`)
      .send({ number: '12b', type: 'APARTMENT', buildingId: b })
      .expect(409);
    expect(dup.body.error.code).toBe('UNIT_NUMBER_TAKEN');

    await as(admin).post(`${base()}/units`).send({ number: 'Villa 9', type: 'VILLA' }).expect(201);
    await as(admin).post(`${base()}/units`).send({ number: 'VILLA 9', type: 'VILLA' }).expect(409);
  });

  it("refuses another building's floor and another property's building", async () => {
    const b1 = await building('U3');
    const b2 = await building('U4');
    const floorOfB2 = (
      await as(admin)
        .post(`${base()}/buildings/${b2}/floors`)
        .send({ level: 1, name: 'One' })
        .expect(201)
    ).body.id;
    await as(admin)
      .post(`${base()}/units`)
      .send({ number: '1', type: 'APARTMENT', buildingId: b1, floorId: floorOfB2 })
      .expect(404);
    const qBuilding = await building('QU', `/api/v1/organisations/${org}/properties/${Q}`);
    await as(admin)
      .post(`${base()}/units`)
      .send({ number: '2', type: 'APARTMENT', buildingId: qBuilding })
      .expect(404);
  });

  it('filters units by building', async () => {
    const b = await building('U5');
    await as(admin)
      .post(`${base()}/units`)
      .send({ number: '501', type: 'STUDIO', buildingId: b })
      .expect(201);
    const list = await as(admin).get(`${base()}/units?buildingId=${b}`).expect(200);
    expect(list.body.data.map((u: { number: string }) => u.number)).toEqual(['501']);
  });
});

describe('archiving', () => {
  it('refuses to archive a building that still has active units, then cascades to its floors', async () => {
    const b = await building('AR');
    const floor = (
      await as(admin)
        .post(`${base()}/buildings/${b}/floors`)
        .send({ level: 1, name: 'One' })
        .expect(201)
    ).body.id;
    const unit = (
      await as(admin)
        .post(`${base()}/units`)
        .send({ number: 'AR-1', type: 'APARTMENT', buildingId: b, floorId: floor })
        .expect(201)
    ).body.id;

    const blocked = await as(admin).post(`${base()}/buildings/${b}/archive`).expect(409);
    expect(blocked.body.error.code).toBe('STRUCTURE_IN_USE');

    await as(admin).post(`${base()}/units/${unit}/archive`).expect(200);
    const archived = await as(admin).post(`${base()}/buildings/${b}/archive`).expect(200);
    expect(archived.body).toMatchObject({ status: 'ARCHIVED', archivedAt: expect.any(String) });
    const floors = await as(admin)
      .get(`${base()}/buildings/${b}/floors?status=ARCHIVED`)
      .expect(200);
    expect(floors.body.data.map((f: { id: string }) => f.id)).toEqual([floor]);

    const intoArchived = await as(admin)
      .post(`${base()}/units`)
      .send({ number: 'AR-2', type: 'APARTMENT', buildingId: b })
      .expect(409);
    expect(intoArchived.body.error.code).toBe('ARCHIVED');
    await as(admin).patch(`${base()}/units/${unit}`).send({ number: 'AR-1X' }).expect(409);
    // Archiving again is harmless.
    await as(admin).post(`${base()}/units/${unit}/archive`).expect(200);
  });

  it('never leaves an active unit in an archived building when create and archive race', async () => {
    for (let round = 0; round < 5; round++) {
      const b = await building(`RACE-${round}`);
      const [created, archived] = await Promise.all([
        as(admin)
          .post(`${base()}/units`)
          .send({ number: `R${round}`, type: 'APARTMENT', buildingId: b }),
        as(admin).post(`${base()}/buildings/${b}/archive`),
      ]);
      // Exactly one of the two wins, never both:
      //   unit first    -> unit 201, archive 409 STRUCTURE_IN_USE, one active unit;
      //   archive first -> archive 200, unit 409 ARCHIVED, no active unit.
      const activeUnits = (await as(admin).get(`${base()}/units?buildingId=${b}`).expect(200)).body
        .data.length;
      const outcome = `${created.status}/${archived.status}/${activeUnits}`;
      expect(['201/409/1', '409/200/0']).toContain(outcome);
    }
  });
});

describe('property lifecycle', () => {
  it('allows country and currency changes only while onboarding', async () => {
    const R = await createProperty(admin, 'LIFE');
    const r = `/api/v1/organisations/${org}/properties/${R}`;
    await as(admin)
      .patch(r)
      .send({ currency: 'usd' })
      .expect(200)
      .expect((res) => {
        expect(res.body.currency).toBe('USD');
      });
    await as(admin)
      .post(`${r}/activate`)
      .expect(200)
      .expect((res) => {
        expect(res.body.status).toBe('ACTIVE');
      });
    const locked = await as(admin).patch(r).send({ currency: 'PKR' }).expect(409);
    expect(locked.body.error.code).toBe('PROPERTY_FINANCIALS_LOCKED');
    await as(admin).patch(r).send({ timeZone: 'Asia/Dubai' }).expect(200);
  });

  it('archives the whole structure and leaves the property readable but frozen', async () => {
    const R = await createProperty(admin, 'GONE');
    const r = `/api/v1/organisations/${org}/properties/${R}`;
    const b = await building('G', r);
    await as(admin)
      .post(`${r}/units`)
      .send({ number: 'G1', type: 'APARTMENT', buildingId: b })
      .expect(201);
    await as(admin).post(`${r}/common-areas`).send({ name: 'Pool', type: 'POOL' }).expect(201);

    const archived = await as(admin).post(`${r}/archive`).expect(200);
    expect(archived.body.status).toBe('ARCHIVED');
    for (const path of ['buildings', 'units', 'common-areas']) {
      expect((await as(admin).get(`${r}/${path}`).expect(200)).body.data).toEqual([]);
      expect(
        (await as(admin).get(`${r}/${path}?status=ARCHIVED`).expect(200)).body.data.length,
      ).toBeGreaterThan(0);
    }
    // Read-only: write permissions are gone at an archived property.
    await as(admin).post(`${r}/buildings`).send({ name: 'Late', code: 'LATE' }).expect(403);
    await as(admin).patch(r).send({ name: 'Renamed' }).expect(403);
    await as(admin).get(r).expect(200);
    expect(await auditCount('property.archived')).toBeGreaterThanOrEqual(1);
  });
});

describe('common areas', () => {
  it('keeps names unique per property and can sit inside a building', async () => {
    const b = await building('CA');
    await as(admin)
      .post(`${base()}/common-areas`)
      .send({ name: 'Gym', type: 'GYM', buildingId: b })
      .expect(201);
    const dup = await as(admin)
      .post(`${base()}/common-areas`)
      .send({ name: 'Gym', type: 'GYM' })
      .expect(409);
    expect(dup.body.error.code).toBe('COMMON_AREA_NAME_TAKEN');
  });
});

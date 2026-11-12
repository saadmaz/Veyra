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
 * Property-scoped authorisation over HTTP against the real database (ACCESS_CONTROL section 5):
 * a property manager of P1 cannot see or act on P2 in the same organisation, scope never
 * reaches upward or sideways, and organisation boundaries still hold.
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

async function createOrganisation(owner: TestUser, slug: string): Promise<string> {
  const res = await as(owner)
    .post('/api/v1/organisations')
    .send({
      name: `Org ${slug}`,
      slug: `${slug}-${run}`,
      countryCode: 'LK',
      defaultCurrency: 'LKR',
      defaultTimeZone: 'Asia/Colombo',
    })
    .expect(201);
  return res.body.id;
}

async function createProperty(owner: TestUser, org: string, code: string) {
  const res = await as(owner)
    .post(`/api/v1/organisations/${org}/properties`)
    .send({
      name: `Residence ${code}`,
      code,
      type: 'CONDOMINIUM',
      addressLine1: '1 Lake Road',
      city: 'Colombo',
    })
    .expect(201);
  return res.body as {
    id: string;
    code: string;
    timeZone: string;
    currency: string;
    countryCode: string;
  };
}

async function inviteAndAccept(
  admin: TestUser,
  org: string,
  invitee: TestUser,
  role: string,
  propertyId?: string,
) {
  const invited = await as(admin)
    .post(`/api/v1/organisations/${org}/invitations`)
    .send({ email: invitee.email, role, ...(propertyId ? { propertyId } : {}) })
    .expect(201);
  await as(invitee)
    .post('/api/v1/invitations/accept')
    .send({ token: invited.body.token })
    .expect(200);
  return invited.body.invitation as { id: string; scopeType: string; scopeId: string };
}

async function membershipId(org: string, userId: string): Promise<string> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [org]);
    const { rows } = await client.query('SELECT id FROM memberships WHERE user_id = $1', [userId]);
    await client.query('COMMIT');
    return rows[0].id;
  } finally {
    client.release();
  }
}

let alice: TestUser; // admin of organisation A
let bob: TestUser; // admin of organisation B
let pam: TestUser; // property manager of P1 only
let carol: TestUser; // organisation-wide finance officer in A
let orgA: string;
let orgB: string;
let p1: { id: string };
let p2: { id: string };
let pb: { id: string };

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

  [alice, bob, pam, carol] = (await Promise.all(['alice', 'bob', 'pam', 'carol'].map(signUp))) as [
    TestUser,
    TestUser,
    TestUser,
    TestUser,
  ];
  orgA = await createOrganisation(alice, 'prop-a');
  orgB = await createOrganisation(bob, 'prop-b');
  p1 = await createProperty(alice, orgA, 'P1');
  p2 = await createProperty(alice, orgA, 'P2');
  pb = await createProperty(bob, orgB, 'PB');
  await inviteAndAccept(alice, orgA, pam, 'PROPERTY_MANAGER', p1.id);
  await inviteAndAccept(alice, orgA, carol, 'FINANCE_OFFICER');
});

afterAll(async () => {
  await app?.close();
  await db?.end();
});

describe('creating properties', () => {
  it('defaults country, time zone and currency to the organisation', async () => {
    const created = await createProperty(alice, orgA, 'DEF-1');
    expect(created).toMatchObject({ countryCode: 'LK', timeZone: 'Asia/Colombo', currency: 'LKR' });
  });

  it('normalises the code and rejects one already used in the organisation', async () => {
    const res = await as(alice)
      .post(`/api/v1/organisations/${orgA}/properties`)
      .send({ name: 'Duplicate', code: 'p1', type: 'OTHER', addressLine1: 'x', city: 'y' })
      .expect(409);
    expect(res.body.error.code).toBe('PROPERTY_CODE_TAKEN');
    // The same code in another organisation is fine (PB/P1 codes are per organisation).
    await createProperty(bob, orgB, 'P1');
  });

  it('validates input', async () => {
    const res = await as(alice)
      .post(`/api/v1/organisations/${orgA}/properties`)
      .send({
        name: '',
        code: 'bad code',
        type: 'CASTLE',
        addressLine1: '',
        city: 'Colombo',
        timeZone: 'Mars/Base',
        currency: 'ZZZ',
      })
      .expect(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'addressLine1',
      'code',
      'currency',
      'name',
      'timeZone',
      'type',
    ]);
  });

  it('is limited to roles with organisation.property.create', async () => {
    for (const user of [pam, carol]) {
      const res = await as(user)
        .post(`/api/v1/organisations/${orgA}/properties`)
        .send({ name: 'Nope', code: 'NOPE', type: 'OTHER', addressLine1: 'x', city: 'y' })
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it('is audited in the organisation', async () => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.organisation_id', $1, true)", [orgA]);
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'property.created'`,
      );
      await client.query('COMMIT');
      expect(rows[0].n).toBeGreaterThanOrEqual(2);
    } finally {
      client.release();
    }
  });
});

describe('a property manager of P1', () => {
  it('is a member of the organisation with only the baseline organisation permission', async () => {
    const mine = await as(pam).get('/api/v1/organisations').expect(200);
    expect(mine.body.data).toEqual([
      { organisation: expect.objectContaining({ id: orgA }), roles: ['PROPERTY_MANAGER'] },
    ]);
    const org = await as(pam).get(`/api/v1/organisations/${orgA}`).expect(200);
    expect(org.body.permissions).toEqual(['organisation.profile.read']);
    await as(pam).get(`/api/v1/organisations/${orgA}/memberships`).expect(403);
  });

  it('sees only P1 in the property list', async () => {
    const list = await as(pam).get(`/api/v1/organisations/${orgA}/properties`).expect(200);
    expect(list.body.data.map((p: { id: string }) => p.id)).toEqual([p1.id]);
  });

  it('can open P1, and P2 looks like it does not exist', async () => {
    const own = await as(pam).get(`/api/v1/organisations/${orgA}/properties/${p1.id}`).expect(200);
    expect(own.body.permissions).toEqual([
      'property.announcement.manage',
      'property.announcement.read',
      'property.document.manage',
      'property.document.read',
      'property.facility.manage',
      'property.facility.read',
      'property.finance.read',
      'property.governance.manage',
      'property.governance.read',
      'property.incident.manage',
      'property.incident.read',
      'property.incident.report',
      'property.maintenance.manage',
      'property.maintenance.read',
      'property.maintenance.work',
      'property.profile.read',
      'property.resident.manage',
      'property.resident.read',
      'property.settings.manage',
      'property.staff.manage',
      'property.staff.read',
      'property.staff.work',
      'property.structure.manage',
      'property.structure.read',
      'property.visitor.check_in',
      'property.visitor.manage',
      'property.visitor.read',
    ]);
    const other = await as(pam)
      .get(`/api/v1/organisations/${orgA}/properties/${p2.id}`)
      .expect(404);
    expect(other.body.error.code).toBe('NOT_FOUND');
  });

  it('cannot reach another organisation’s property by either path', async () => {
    await as(pam).get(`/api/v1/organisations/${orgB}/properties/${pb.id}`).expect(404);
    await as(pam).get(`/api/v1/organisations/${orgA}/properties/${pb.id}`).expect(404);
  });

  it('loses access on the next request when suspended, and regains it when reactivated', async () => {
    const id = await membershipId(orgA, pam.id);
    await as(alice)
      .patch(`/api/v1/organisations/${orgA}/memberships/${id}`)
      .send({ status: 'SUSPENDED' })
      .expect(200);
    await as(pam).get(`/api/v1/organisations/${orgA}/properties/${p1.id}`).expect(404);
    await as(pam).get(`/api/v1/organisations/${orgA}`).expect(404);

    await as(alice)
      .patch(`/api/v1/organisations/${orgA}/memberships/${id}`)
      .send({ status: 'ACTIVE' })
      .expect(200);
    await as(pam).get(`/api/v1/organisations/${orgA}/properties/${p1.id}`).expect(200);
  });
});

describe('organisation-wide roles', () => {
  it('a finance officer sees every property of the organisation, and no other organisation', async () => {
    const list = await as(carol)
      .get(`/api/v1/organisations/${orgA}/properties?limit=200`)
      .expect(200);
    const ids = list.body.data.map((p: { id: string }) => p.id);
    expect(ids).toEqual(expect.arrayContaining([p1.id, p2.id]));
    expect(ids).not.toContain(pb.id);
    await as(carol).get(`/api/v1/organisations/${orgA}/properties/${p2.id}`).expect(200);
  });

  it('non-members get 404 on every property route', async () => {
    for (const res of [
      await as(bob).get(`/api/v1/organisations/${orgA}/properties`),
      await as(bob).get(`/api/v1/organisations/${orgA}/properties/${p1.id}`),
      await as(bob)
        .post(`/api/v1/organisations/${orgA}/properties`)
        .send({ name: 'X', code: 'XX', type: 'OTHER', addressLine1: 'x', city: 'y' }),
    ]) {
      expect(res.status).toBe(404);
    }
  });

  it('paginates the property list', async () => {
    const first = await as(alice)
      .get(`/api/v1/organisations/${orgA}/properties?limit=1`)
      .expect(200);
    expect(first.body.data).toHaveLength(1);
    const second = await as(alice)
      .get(`/api/v1/organisations/${orgA}/properties?limit=1&cursor=${first.body.nextCursor}`)
      .expect(200);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
  });
});

describe('property-scoped invitations', () => {
  it('records the property scope on the invitation', async () => {
    const quinn = await signUp('quinn');
    const invitation = await inviteAndAccept(alice, orgA, quinn, 'PROPERTY_MANAGER', p2.id);
    expect(invitation).toMatchObject({ scopeType: 'PROPERTY', scopeId: p2.id });
    await as(quinn).get(`/api/v1/organisations/${orgA}/properties/${p2.id}`).expect(200);
    await as(quinn).get(`/api/v1/organisations/${orgA}/properties/${p1.id}`).expect(404);
  });

  it('requires a property for property-only roles', async () => {
    const res = await as(alice)
      .post(`/api/v1/organisations/${orgA}/invitations`)
      .send({ email: `x-${run}@example.test`, role: 'PROPERTY_MANAGER' })
      .expect(422);
    expect(res.body.error.code).toBe('ROLE_SCOPE_MISMATCH');
  });

  it('rejects a property from another organisation', async () => {
    const res = await as(alice)
      .post(`/api/v1/organisations/${orgA}/invitations`)
      .send({ email: `y-${run}@example.test`, role: 'PROPERTY_MANAGER', propertyId: pb.id })
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('allows pending invitations for the same person on different properties', async () => {
    const email = `rita-${run}@example.test`;
    for (const property of [p1, p2]) {
      await as(alice)
        .post(`/api/v1/organisations/${orgA}/invitations`)
        .send({ email, role: 'PROPERTY_MANAGER', propertyId: property.id })
        .expect(201);
    }
    const again = await as(alice)
      .post(`/api/v1/organisations/${orgA}/invitations`)
      .send({ email, role: 'PROPERTY_MANAGER', propertyId: p1.id })
      .expect(409);
    expect(again.body.error.code).toBe('INVITATION_PENDING');
  });

  it('still lets an admin invite an organisation-wide finance officer', async () => {
    await as(alice)
      .post(`/api/v1/organisations/${orgA}/invitations`)
      .send({ email: `fin-${run}@example.test`, role: 'FINANCE_OFFICER' })
      .expect(201);
  });
});

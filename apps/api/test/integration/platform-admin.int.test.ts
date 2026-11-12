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
 * Platform administration over HTTP (Phase 13 Part 2): only platform administrators see the
 * platform routes (404 for everyone else, organisation admins included); they list
 * organisations with plans and usage counts, change a plan (which switches features at once)
 * and suspend or reactivate an organisation, always with a reason, recorded in the customer's
 * subscription history.
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
});

const u = {} as Record<'admin' | 'mgr' | 'guard' | 'tech' | 'outsider' | 'staff', TestUser>;
let org: string;
let P: string;
const orgUrl = () => `/api/v1/organisations/${org}`;
const pUrl = () => `${orgUrl()}/properties/${P}`;
const platform = (path = '') => `/api/v1/platform${path}`;

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

  for (const name of ['admin', 'mgr', 'guard', 'tech', 'outsider', 'staff'] as const)
    u[name] = await signUp(name);
  org = (
    await as(u.admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Platform Org',
        slug: `platform-${run}`,
        countryCode: 'PK',
        defaultCurrency: 'PKR',
        defaultTimeZone: 'Asia/Karachi',
      })
      .expect(201)
  ).body.id;
  P = (
    await as(u.admin)
      .post(`${orgUrl()}/properties`)
      .send({
        name: 'Platform Tower',
        code: 'PT',
        type: 'CONDOMINIUM',
        addressLine1: '1 Road',
        city: 'Karachi',
      })
      .expect(201)
  ).body.id;
  for (const [user, role] of [
    [u.mgr, 'PROPERTY_MANAGER'],
    [u.guard, 'SECURITY_GUARD'],
    [u.tech, 'TECHNICIAN'],
  ] as const) {
    const invited = await as(u.admin)
      .post(`${orgUrl()}/invitations`)
      .send({ email: user.email, role, propertyId: P })
      .expect(201);
    await as(user)
      .post('/api/v1/invitations/accept')
      .send({ token: invited.body.token })
      .expect(200);
  }
  const client = new pg.Client({ connectionString: inject('superuserDatabaseUrl') });
  await client.connect();
  await client.query(`INSERT INTO platform_admins (user_id, note) VALUES ($1, 'test')`, [
    u.staff.id,
  ]);
  await client.end();
});

afterAll(async () => {
  await app?.close();
});

describe('platform administration', () => {
  it('is hidden from everyone but platform administrators', async () => {
    expect((await as(u.admin).get(platform('/me')).expect(200)).body).toEqual({
      platformAdmin: false,
    });
    await as(u.admin).get(platform('/organisations')).expect(404);
    await as(u.admin)
      .get(platform(`/organisations/${org}`))
      .expect(404);
    expect((await as(u.staff).get(platform('/me')).expect(200)).body).toEqual({
      platformAdmin: true,
    });
  });

  it('lists organisations with their plan and usage, not their data', async () => {
    const list = (await as(u.staff).get(platform('/organisations?search=Platform')).expect(200))
      .body.data;
    const mine = list.find((o: { id: string }) => o.id === org);
    expect(mine).toMatchObject({
      name: 'Platform Org',
      status: 'ACTIVE',
      subscription: { planCode: 'ENTERPRISE', status: 'TRIAL' },
    });
    const detail = (
      await as(u.staff)
        .get(platform(`/organisations/${org}`))
        .expect(200)
    ).body;
    expect(detail.usage).toEqual({ properties: 1, units: 0, members: 4 });
    expect(JSON.stringify(detail)).not.toContain('Platform Tower');
    expect(
      (await as(u.staff).get(platform('/plans')).expect(200)).body.data.map(
        (p: { code: string }) => p.code,
      ),
    ).toEqual(['STARTER', 'PROFESSIONAL', 'ENTERPRISE']);
  });

  it('changes plans with a reason, switching features at once', async () => {
    await as(u.staff)
      .post(platform(`/organisations/${org}/subscription`))
      .send({ planCode: 'STARTER', status: 'ACTIVE' })
      .expect(400);
    await as(u.staff)
      .post(platform(`/organisations/${org}/subscription`))
      .send({ planCode: 'GOLD', status: 'ACTIVE', reason: 'x' })
      .expect(422);
    const changed = (
      await as(u.staff)
        .post(platform(`/organisations/${org}/subscription`))
        .send({ planCode: 'STARTER', status: 'ACTIVE', reason: 'Signed the Starter plan' })
        .expect(200)
    ).body;
    expect(changed.organisation.subscription).toMatchObject({
      planCode: 'STARTER',
      status: 'ACTIVE',
    });
    expect(changed.history[0]).toMatchObject({
      toPlan: 'STARTER',
      reason: 'Signed the Starter plan',
    });
    await as(u.guard).get(`${pUrl()}/incidents`).expect(403);
    const own = (await as(u.admin).get(`${orgUrl()}/subscription`).expect(200)).body;
    expect(own.history[0]).toMatchObject({ toPlan: 'STARTER', reason: 'Signed the Starter plan' });
  });

  it('suspends and reactivates an organisation, with a reason', async () => {
    await as(u.staff)
      .post(platform(`/organisations/${org}/suspend`))
      .send({})
      .expect(400);
    await as(u.staff)
      .post(platform(`/organisations/${org}/suspend`))
      .send({ reason: 'Unpaid for 60 days' })
      .expect(200);
    await as(u.admin).post(`${pUrl()}/units`).send({ number: 'S1', type: 'APARTMENT' }).expect(403);
    await as(u.admin).get(pUrl()).expect(200);
    await as(u.staff)
      .post(platform(`/organisations/${org}/suspend`))
      .send({ reason: 'again' })
      .expect(409);
    await as(u.staff)
      .post(platform(`/organisations/${org}/reactivate`))
      .send({ reason: 'Paid' })
      .expect(200);
    await as(u.admin).post(`${pUrl()}/units`).send({ number: 'S1', type: 'APARTMENT' }).expect(201);
  });
});

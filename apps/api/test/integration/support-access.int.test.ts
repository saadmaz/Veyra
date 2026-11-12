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
 * Support access over HTTP (Phase 13 Part 3): a platform administrator sees nothing of an
 * organisation until an organisation admin approves their request; then they read (and only
 * read) for the approved hours; revocation ends it at once; property managers cannot decide, and
 * the requester cannot approve their own request.
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
        name: 'Support Org',
        slug: `support-${run}`,
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
        name: 'Support Tower',
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

const sUrl = (path = '') => `${orgUrl()}/support-access${path}`;

describe('support access', () => {
  let request: string;

  it('is asked for by platform admins only, and gives nothing until approved', async () => {
    await as(u.staff).get(pUrl()).expect(404);
    await as(u.mgr)
      .post(platform(`/organisations/${org}/support-access`))
      .send({ reason: 'x', hours: 1 })
      .expect(404);
    await as(u.staff)
      .post(platform(`/organisations/${org}/support-access`))
      .send({ reason: 'Help with an invoice', hours: 30 })
      .expect(400);
    const asked = (
      await as(u.staff)
        .post(platform(`/organisations/${org}/support-access`))
        .send({ reason: 'Help with an invoice question', hours: 2 })
        .expect(201)
    ).body;
    request = asked.id;
    expect(asked).toMatchObject({ status: 'REQUESTED', active: false, hours: 2 });
    await as(u.staff).get(pUrl()).expect(404);
    const listed = (await as(u.admin).get(sUrl()).expect(200)).body.data;
    expect(listed[0]).toMatchObject({ id: request, reason: 'Help with an invoice question' });
    expect((await as(u.staff).get(platform('/support-access')).expect(200)).body.data[0].id).toBe(
      request,
    );
  });

  it('is decided by organisation admins, giving read-only access for the hours', async () => {
    await as(u.mgr)
      .post(sUrl(`/${request}/approve`))
      .expect(403);
    const approved = (
      await as(u.admin)
        .post(sUrl(`/${request}/approve`))
        .expect(200)
    ).body;
    expect(approved).toMatchObject({ status: 'APPROVED', active: true, decidedBy: 'admin' });
    await as(u.staff).get(pUrl()).expect(200);
    await as(u.staff).get(`${pUrl()}/incidents`).expect(200);
    await as(u.staff).post(`${pUrl()}/units`).send({ number: 'X1', type: 'APARTMENT' }).expect(403);
    await as(u.staff)
      .post(sUrl(`/${request}/revoke`))
      .expect(403);
    await as(u.staff)
      .get(`${pUrl()}/exports`)
      .expect(200)
      .expect((res) => {
        expect(res.body.data).toEqual([]);
      });
  });

  it('ends at once when revoked', async () => {
    const revoked = (
      await as(u.admin)
        .post(sUrl(`/${request}/revoke`))
        .expect(200)
    ).body;
    expect(revoked).toMatchObject({ status: 'REVOKED', active: false });
    await as(u.staff).get(pUrl()).expect(404);
    await as(u.admin)
      .post(sUrl(`/${request}/approve`))
      .expect(409);
  });
});

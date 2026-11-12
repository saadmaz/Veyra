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
 * Subscriptions over HTTP (Phase 13 Part 1): an organisation admin sees the plan, limits, usage
 * and history; a smaller plan switches features off for everyone (their routes answer 403 and
 * their permissions disappear) and caps properties and units (409 PLAN_LIMIT_REACHED); an ended
 * trial makes the organisation read-only until the plan is active again.
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

const u = {} as Record<'admin' | 'mgr' | 'guard' | 'tech' | 'outsider', TestUser>;
let org: string;
let P: string;
const orgUrl = () => `/api/v1/organisations/${org}`;
const pUrl = () => `${orgUrl()}/properties/${P}`;

/** Changes the subscription as platform administration will (Part 2), as the database owner. */
async function setSubscription(sql: string) {
  const client = new pg.Client({ connectionString: inject('superuserDatabaseUrl') });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [org]);
    await client.query(`UPDATE subscriptions SET ${sql} WHERE organisation_id = $1`, [org]);
    await client.query('COMMIT');
  } finally {
    await client.end();
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
    .useValue(new InMemoryRateLimiter())
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, env);
  await app.init();

  for (const name of ['admin', 'mgr', 'guard', 'tech', 'outsider'] as const)
    u[name] = await signUp(name);
  org = (
    await as(u.admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Plan Org',
        slug: `plans-${run}`,
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
        name: 'Plan Tower',
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
});

afterAll(async () => {
  await app?.close();
});

describe('subscriptions', () => {
  it('show admins the plan, limits, usage and history', async () => {
    const s = (await as(u.admin).get(`${orgUrl()}/subscription`).expect(200)).body;
    expect(s).toMatchObject({
      plan: { code: 'ENTERPRISE', maxProperties: null, maxUnits: null },
      status: 'TRIAL',
      lapsed: false,
      usage: { properties: 1, units: 0 },
    });
    expect(s.history).toHaveLength(1);
    await as(u.mgr).get(`${orgUrl()}/subscription`).expect(403);
  });

  it('switch off features outside the plan, for everyone', async () => {
    await as(u.guard).get(`${pUrl()}/incidents`).expect(200);
    await setSubscription(`plan_code = 'STARTER', status = 'ACTIVE', trial_ends_at = NULL`);
    await as(u.guard).get(`${pUrl()}/incidents`).expect(403);
    await as(u.mgr).get(`${pUrl()}/committees`).expect(403);
    const property = (await as(u.mgr).get(pUrl()).expect(200)).body;
    expect(property.permissions).not.toContain('property.incident.read');
    expect(property.permissions).toContain('property.maintenance.read');
    await as(u.mgr).get(`${pUrl()}/maintenance/requests`).expect(200);
  });

  it('cap properties and units by the plan', async () => {
    await as(u.admin)
      .post(`${orgUrl()}/properties`)
      .send({
        name: 'Second',
        code: 'SEC',
        type: 'CONDOMINIUM',
        addressLine1: '2 Road',
        city: 'Karachi',
      })
      .expect(409)
      .expect((res) => expect(res.body.error.code).toBe('PLAN_LIMIT_REACHED'));
    await setSubscription(`plan_code = 'PROFESSIONAL'`);
    await as(u.admin)
      .post(`${orgUrl()}/properties`)
      .send({
        name: 'Second',
        code: 'SEC',
        type: 'CONDOMINIUM',
        addressLine1: '2 Road',
        city: 'Karachi',
      })
      .expect(201);
  });

  it('make the organisation read-only when the trial has ended', async () => {
    await setSubscription(
      `plan_code = 'ENTERPRISE', status = 'TRIAL', trial_ends_at = now() - interval '1 day'`,
    );
    await as(u.guard).get(`${pUrl()}/incidents`).expect(200);
    await as(u.guard)
      .post(`${pUrl()}/incidents`)
      .send({
        category: 'SECURITY',
        severity: 'LOW',
        title: 'Gate open',
        description: 'Found open.',
        occurredAt: new Date(Date.now() - 60_000).toISOString(),
      })
      .expect(403);
    expect((await as(u.admin).get(`${orgUrl()}/subscription`).expect(200)).body.lapsed).toBe(true);
    await setSubscription(`status = 'ACTIVE', trial_ends_at = NULL`);
    await as(u.admin).post(`${pUrl()}/units`).send({ number: 'A1', type: 'APARTMENT' }).expect(201);
  });
});

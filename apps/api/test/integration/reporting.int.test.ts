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
 * Dashboards over HTTP (Phase 12 Part 1): each area of a property's dashboard appears only for
 * people who can see that area, figures are counts and totals, sensitive incidents count only for
 * incident managers, and people outside the property get nothing.
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

const u = {} as Record<'admin' | 'mgr' | 'guard' | 'tech' | 'outsider' | 'tenant', TestUser>;
let org: string;
let P: string;
const orgUrl = () => `/api/v1/organisations/${org}`;
const dUrl = () => `${orgUrl()}/properties/${P}/dashboard`;

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

  for (const name of ['admin', 'mgr', 'guard', 'tech', 'outsider', 'tenant'] as const)
    u[name] = await signUp(name);
  org = (
    await as(u.admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Reporting Org',
        slug: `reporting-${run}`,
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
        name: 'Reporting Tower',
        code: 'RT',
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
  const pUrl = `${orgUrl()}/properties/${P}`;
  const units: string[] = [];
  for (const number of ['R1', 'R2']) {
    units.push(
      (await as(u.admin).post(`${pUrl}/units`).send({ number, type: 'APARTMENT' }).expect(201)).body
        .id,
    );
  }
  const person = (
    await as(u.admin)
      .post(`${pUrl}/persons`)
      .send({ fullName: 'Tara Tenant', email: u.tenant.email })
      .expect(201)
  ).body.id;
  await as(u.admin)
    .post(`${pUrl}/units/${units[0]}/tenancies`)
    .send({ startDate: '2026-01-01', occupants: [{ personId: person, isPrimary: true }] })
    .expect(201);
  const incident = (over: Record<string, unknown>) =>
    as(u.guard)
      .post(`${pUrl}/incidents`)
      .send({
        category: 'SECURITY',
        severity: 'LOW',
        title: 'Gate open',
        description: 'Found open.',
        occurredAt: new Date(Date.now() - 600_000).toISOString(),
        ...over,
      })
      .expect(201);
  await incident({ severity: 'HIGH' });
  await incident({ sensitive: true, title: 'Assault' });
});

afterAll(async () => {
  await app?.close();
});

describe('dashboards', () => {
  it('show a manager every area they run', async () => {
    const d = (await as(u.mgr).get(dUrl()).expect(200)).body;
    expect(d.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.occupancy).toEqual({ units: 2, withOwner: 0, tenanted: 1 });
    expect(d.incidents).toEqual({ open: 2, openHighOrCritical: 1 });
    expect(d.finance).toEqual({
      outstanding: { amountMinor: '0', currency: 'PKR' },
      overdue: { amountMinor: '0', currency: 'PKR' },
      overdueInvoices: 0,
      collectedLast30Days: { amountMinor: '0', currency: 'PKR' },
    });
    expect(d.maintenance).toEqual({ openRequests: 0, overdueRequests: 0, openWorkOrders: 0 });
    expect(d.visitors).toEqual({ arrivedToday: 0, onSiteNow: 0, last7Days: 0 });
    expect(d.facilities).toEqual({ bookingsNext7Days: 0, awaitingApproval: 0 });
    expect(d.pendingApprovals).toBe(0);
  });

  it('show other staff only their areas, without sensitive incidents', async () => {
    const guard = (await as(u.guard).get(dUrl()).expect(200)).body;
    expect(guard.finance).toBeNull();
    expect(guard.maintenance).toBeNull();
    expect(guard.visitors).toBeNull();
    expect(guard.pendingApprovals).toBeNull();
    expect(guard.occupancy).toEqual({ units: 2, withOwner: 0, tenanted: 1 });
    expect(guard.incidents).toEqual({ open: 1, openHighOrCritical: 1 });
    const tech = (await as(u.tech).get(dUrl()).expect(200)).body;
    expect(tech.incidents).toEqual({ open: 1, openHighOrCritical: 1 });
    expect(tech.facilities).toBeNull();
  });

  it('give nothing to people outside the property', async () => {
    await as(u.outsider).get(dUrl()).expect(404);
  });
});

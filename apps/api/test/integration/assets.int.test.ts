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
 * Assets and preventive maintenance over HTTP (Phase 9 Part 2): maintenance managers keep the
 * register and schedules; due work is raised once per date, at the asset's place, to the
 * schedule's vendor, and the next date moves on; out-of-service assets are skipped; retiring
 * waits for paused schedules and finished work; technicians cannot change assets.
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

const u = {} as Record<'admin' | 'mgr' | 'tech', TestUser>;
let org: string;
let P: string;
let plant: string;
let vendor: string;
const orgUrl = () => `/api/v1/organisations/${org}`;
const mUrl = (path: string) => `${orgUrl()}/properties/${P}/maintenance/${path}`;
/** A Karachi (UTC+5) date `days` from today. */
const dateIn = (days: number) =>
  new Date(Date.now() + 5 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);

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

  for (const name of ['admin', 'mgr', 'tech'] as const) u[name] = await signUp(name);
  org = (
    await as(u.admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Asset Org',
        slug: `asset-${run}`,
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
        name: 'Asset Tower',
        code: 'AT',
        type: 'CONDOMINIUM',
        addressLine1: '1 Road',
        city: 'Karachi',
      })
      .expect(201)
  ).body.id;
  for (const [user, role] of [
    [u.mgr, 'MAINTENANCE_MANAGER'],
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
  plant = (
    await as(u.admin)
      .post(`${orgUrl()}/properties/${P}/common-areas`)
      .send({ name: 'Plant room', type: 'OTHER' })
      .expect(201)
  ).body.id;
  vendor = (
    await as(u.admin)
      .post(`${orgUrl()}/vendors`)
      .send({ name: 'Lift Masters', categories: ['LIFT'] })
      .expect(201)
  ).body.vendor.id;
});

afterAll(async () => {
  await app?.close();
});

describe('assets', () => {
  it('are registered by managers with a unique tag; technicians only read', async () => {
    const created = await as(u.mgr)
      .post(mUrl('assets'))
      .send({
        tag: 'lift-01',
        name: 'Passenger lift',
        category: 'LIFT',
        commonAreaId: plant,
        manufacturer: 'Otis',
        warrantyExpiresOn: dateIn(100),
        supplierVendorId: vendor,
      })
      .expect(201);
    expect(created.body.asset).toMatchObject({
      tag: 'LIFT-01',
      status: 'ACTIVE',
      commonAreaName: 'Plant room',
      underWarranty: true,
      supplier: { id: vendor, name: 'Lift Masters' },
    });
    expect(
      (
        await as(u.mgr)
          .post(mUrl('assets'))
          .send({ tag: 'LIFT-01', name: 'Again', category: 'LIFT', commonAreaId: plant })
          .expect(409)
      ).body.error.code,
    ).toBe('TAG_TAKEN');
    await as(u.tech)
      .post(mUrl('assets'))
      .send({ tag: 'X', name: 'X', category: 'LIFT', commonAreaId: plant })
      .expect(403);
    await as(u.tech).get(mUrl('assets')).expect(403);
  });
});

describe('preventive maintenance', () => {
  it('raises due work once, to the vendor, and moves the next date on', async () => {
    const asset = (
      await as(u.mgr)
        .post(mUrl('assets'))
        .send({ tag: 'PUMP-01', name: 'Booster pump', category: 'PLUMBING', commonAreaId: plant })
        .expect(201)
    ).body.asset.id;
    const withSchedule = await as(u.mgr)
      .post(mUrl(`assets/${asset}/schedules`))
      .send({
        title: 'Monthly pump service',
        intervalUnit: 'MONTH',
        intervalCount: 1,
        nextDueOn: dateIn(3),
        leadDays: 7,
        vendorId: vendor,
      })
      .expect(201);
    const scheduleId = withSchedule.body.schedules[0].id;
    // A schedule far ahead is not due.
    await as(u.mgr)
      .post(mUrl(`assets/${asset}/schedules`))
      .send({
        title: 'Yearly overhaul',
        intervalUnit: 'MONTH',
        intervalCount: 12,
        nextDueOn: dateIn(200),
      })
      .expect(201);

    const overview = (await as(u.mgr).get(mUrl('schedules')).expect(200)).body.data;
    expect(overview.filter((s: { due: boolean }) => s.due)).toHaveLength(1);

    const first = (await as(u.mgr).post(mUrl('schedules/raise-due')).expect(200)).body;
    expect(first.raised).toEqual([
      expect.objectContaining({ assetTag: 'PUMP-01', scheduledFor: dateIn(3) }),
    ]);
    const second = (await as(u.mgr).post(mUrl('schedules/raise-due')).expect(200)).body;
    expect(second.raised).toEqual([]);

    const detail = (
      await as(u.mgr)
        .get(mUrl(`assets/${asset}`))
        .expect(200)
    ).body;
    const monthly = detail.schedules.find((s: { id: string }) => s.id === scheduleId);
    expect(monthly.nextDueOn > dateIn(3)).toBe(true);
    expect(detail.history).toHaveLength(1);
    expect(detail.history[0]).toMatchObject({
      title: 'Monthly pump service',
      status: 'ASSIGNED',
      scheduledFor: dateIn(3),
    });
    const work = (
      await as(u.mgr)
        .get(mUrl(`work-orders/${detail.history[0].id}`))
        .expect(200)
    ).body.workOrder;
    expect(work).toMatchObject({
      vendor: { id: vendor },
      commonAreaId: plant,
      category: 'PLUMBING',
    });
  });

  it('skips assets out of service, and retires one only when nothing is scheduled or open', async () => {
    const asset = (
      await as(u.mgr)
        .post(mUrl('assets'))
        .send({ tag: 'GEN-01', name: 'Generator', category: 'ELECTRICAL', commonAreaId: plant })
        .expect(201)
    ).body.asset.id;
    const scheduleId = (
      await as(u.mgr)
        .post(mUrl(`assets/${asset}/schedules`))
        .send({
          title: 'Weekly test run',
          intervalUnit: 'WEEK',
          intervalCount: 1,
          nextDueOn: dateIn(0),
          leadDays: 0,
        })
        .expect(201)
    ).body.schedules[0].id;
    await as(u.mgr)
      .post(mUrl(`assets/${asset}/out-of-service`))
      .send({ reason: 'Alternator failed' })
      .expect(200);
    const result = (await as(u.mgr).post(mUrl('schedules/raise-due')).expect(200)).body;
    expect(result.skipped).toEqual([{ scheduleId, reason: 'The asset is out of service' }]);

    await as(u.mgr)
      .post(mUrl(`assets/${asset}/retire`))
      .send({ reason: 'Replaced' })
      .expect(409);
    await as(u.mgr)
      .patch(mUrl(`schedules/${scheduleId}`))
      .send({ active: false })
      .expect(200);
    const retired = (
      await as(u.mgr)
        .post(mUrl(`assets/${asset}/retire`))
        .send({ reason: 'Replaced' })
        .expect(200)
    ).body.asset;
    expect(retired).toMatchObject({ status: 'RETIRED', statusNote: 'Replaced' });
    await as(u.mgr)
      .patch(mUrl(`assets/${asset}`))
      .send({ name: 'Renamed' })
      .expect(409);
  });
});

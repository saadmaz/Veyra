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
 * Vendors over HTTP against the real database (Phase 9 Part 1): organisation admins keep the
 * register and compliance documents, finance officers read it, property staff cannot; compliance
 * follows the documents' expiry; maintenance managers give work to active vendors only, and a
 * vendor with open work is not archived.
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

const u = {} as Record<'admin' | 'mgr' | 'finance', TestUser>;
let org: string;
let P: string;
let unit: string;
const orgUrl = () => `/api/v1/organisations/${org}`;
const vUrl = (path = '') => `${orgUrl()}/vendors${path ? `/${path}` : ''}`;
const mUrl = (path: string) => `${orgUrl()}/properties/${P}/maintenance/${path}`;

/** A date `days` from today, YYYY-MM-DD (Karachi is UTC+5). */
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

  for (const name of ['admin', 'mgr', 'finance'] as const) u[name] = await signUp(name);
  org = (
    await as(u.admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Vendor Org',
        slug: `vend-${run}`,
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
        name: 'Vendor Tower',
        code: 'VT',
        type: 'CONDOMINIUM',
        addressLine1: '1 Road',
        city: 'Karachi',
      })
      .expect(201)
  ).body.id;
  for (const [user, role, propertyId] of [
    [u.mgr, 'MAINTENANCE_MANAGER', P],
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
  unit = (
    await as(u.admin)
      .post(`${orgUrl()}/properties/${P}/units`)
      .send({ number: 'V1', type: 'APARTMENT' })
      .expect(201)
  ).body.id;
});

afterAll(async () => {
  await app?.close();
});

describe('register', () => {
  it('is kept by organisation admins, read by finance and closed to property staff', async () => {
    const created = await as(u.admin)
      .post(vUrl())
      .send({
        name: 'AquaFix Plumbing',
        categories: ['PLUMBING'],
        email: 'Ops@AquaFix.example',
        phone: '+92 300 0000000',
      })
      .expect(201);
    expect(created.body.vendor).toMatchObject({
      name: 'AquaFix Plumbing',
      email: 'ops@aquafix.example',
      status: 'ACTIVE',
      compliance: 'NO_DOCUMENTS',
      categories: ['PLUMBING'],
    });
    expect(
      (await as(u.admin).post(vUrl()).send({ name: 'aquafix plumbing' }).expect(409)).body.error
        .code,
    ).toBe('NAME_TAKEN');
    await as(u.admin).post(vUrl()).send({ name: 'Bad', email: 'not-an-email' }).expect(400);
    const list = (await as(u.finance).get(vUrl()).expect(200)).body.data;
    expect(list.map((v: { name: string }) => v.name)).toContain('AquaFix Plumbing');
    await as(u.finance).post(vUrl()).send({ name: 'Finance Pick' }).expect(403);
    await as(u.mgr).get(vUrl()).expect(403);
  });

  it('follows compliance from the documents and their expiry', async () => {
    const id = (
      await as(u.admin)
        .post(vUrl())
        .send({ name: 'Cool Air HVAC', categories: ['HVAC'] })
        .expect(201)
    ).body.vendor.id;
    const lapsed = await as(u.admin)
      .post(vUrl(`${id}/documents`))
      .send({ kind: 'INSURANCE', title: 'Public liability', expiresOn: dateIn(-1) })
      .expect(201);
    expect(lapsed.body.vendor.compliance).toBe('EXPIRED');
    expect(lapsed.body.documents[0]).toMatchObject({ expired: true, addedBy: 'admin' });
    const voided = await as(u.admin)
      .post(vUrl(`${id}/documents/${lapsed.body.documents[0].id}/void`))
      .send({ reason: 'Wrong policy' })
      .expect(200);
    expect(voided.body.vendor.compliance).toBe('NO_DOCUMENTS');
    await as(u.admin)
      .post(vUrl(`${id}/documents/${lapsed.body.documents[0].id}/void`))
      .send({ reason: 'Again' })
      .expect(409);
    const soon = await as(u.admin)
      .post(vUrl(`${id}/documents`))
      .send({ kind: 'INSURANCE', title: 'Renewed policy', expiresOn: dateIn(10) })
      .expect(201);
    expect(soon.body.vendor.compliance).toBe('EXPIRING_SOON');
    await as(u.admin)
      .post(vUrl(`${id}/documents`))
      .send({ kind: 'LICENCE', title: 'Trade licence', validFrom: dateIn(5), expiresOn: dateIn(1) })
      .expect(400);
  });
});

describe('work orders', () => {
  it('go only to active vendors, logged, and keep a vendor with open work from archiving', async () => {
    const lift = (
      await as(u.admin)
        .post(vUrl())
        .send({ name: 'Lift Masters', categories: ['LIFT'] })
        .expect(201)
    ).body.vendor.id;
    const paused = (await as(u.admin).post(vUrl()).send({ name: 'Paused Painters' }).expect(201))
      .body.vendor.id;
    await as(u.admin)
      .post(vUrl(`${paused}/suspend`))
      .send({ reason: 'Complaints' })
      .expect(200);

    const offered = (await as(u.mgr).get(mUrl('vendors')).expect(200)).body.data;
    expect(offered.map((v: { name: string }) => v.name)).toContain('Lift Masters');
    expect(offered.map((v: { name: string }) => v.name)).not.toContain('Paused Painters');

    const work = (
      await as(u.mgr)
        .post(mUrl('work-orders'))
        .send({ unitId: unit, title: 'Lift stuck', category: 'LIFT' })
        .expect(201)
    ).body;
    const workId = work.workOrder?.id ?? work.id;
    const given = await as(u.mgr)
      .post(mUrl(`work-orders/${workId}/vendor`))
      .send({ vendorId: lift })
      .expect(200);
    expect(given.body.workOrder).toMatchObject({
      status: 'ASSIGNED',
      vendor: { id: lift, name: 'Lift Masters' },
      assignedTo: null,
    });
    expect(given.body.events.map((e: { type: string }) => e.type)).toContain('VENDOR_CHANGED');

    const other = (
      await as(u.mgr)
        .post(mUrl('work-orders'))
        .send({ unitId: unit, title: 'Repaint hall', category: 'PAINTING' })
        .expect(201)
    ).body;
    const refused = await as(u.mgr)
      .post(mUrl(`work-orders/${other.workOrder?.id ?? other.id}/vendor`))
      .send({ vendorId: paused })
      .expect(409);
    expect(refused.body.error.code).toBe('VENDOR_NOT_ACTIVE');

    expect(
      (
        await as(u.admin)
          .post(vUrl(`${lift}/archive`))
          .expect(409)
      ).body.error.code,
    ).toBe('OPEN_WORK');
    const removed = await as(u.mgr)
      .post(mUrl(`work-orders/${workId}/vendor`))
      .send({ vendorId: null })
      .expect(200);
    expect(removed.body.workOrder).toMatchObject({ status: 'OPEN', vendor: null });
    const archived = await as(u.admin)
      .post(vUrl(`${lift}/archive`))
      .expect(200);
    expect(archived.body.vendor.status).toBe('ARCHIVED');
    await as(u.admin).patch(vUrl(lift)).send({ notes: 'Late' }).expect(409);
  });
});

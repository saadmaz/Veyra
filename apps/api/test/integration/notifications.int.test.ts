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
 * Notifications over HTTP (Phase 10 Part 2): a manager's decision on a booking, the property
 * team accepting a maintenance request, and an urgent announcement each notify the people
 * concerned in the same transaction, with an email delivery waiting for the worker; people see
 * only their own feed and mark it read; managers see how deliveries went.
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
});

const u = {} as Record<'admin' | 'mgr' | 'tenant' | 'stranger', TestUser>;
let org: string;
let P: string;
let unit: string;
const orgUrl = () => `/api/v1/organisations/${org}`;
const pUrl = () => `${orgUrl()}/properties/${P}`;
const feed = (user: TestUser) => as(user).get(`${orgUrl()}/notifications`).expect(200);

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

  for (const name of ['admin', 'mgr', 'tenant', 'stranger'] as const) u[name] = await signUp(name);
  org = (
    await as(u.admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Notify Org',
        slug: `notify-${run}`,
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
        name: 'Notify Tower',
        code: 'NO',
        type: 'CONDOMINIUM',
        addressLine1: '1 Road',
        city: 'Karachi',
      })
      .expect(201)
  ).body.id;
  const invited = await as(u.admin)
    .post(`${orgUrl()}/invitations`)
    .send({ email: u.mgr.email, role: 'PROPERTY_MANAGER', propertyId: P })
    .expect(201);
  await as(u.mgr)
    .post('/api/v1/invitations/accept')
    .send({ token: invited.body.token })
    .expect(200);
  unit = (
    await as(u.admin).post(`${pUrl()}/units`).send({ number: 'N1', type: 'APARTMENT' }).expect(201)
  ).body.id;
  const person = (
    await as(u.admin)
      .post(`${pUrl()}/persons`)
      .send({ fullName: 'Tara Tenant', email: u.tenant.email })
      .expect(201)
  ).body.id;
  await as(u.admin)
    .post(`${pUrl()}/units/${unit}/tenancies`)
    .send({ startDate: '2026-01-01', occupants: [{ personId: person, isPrimary: true }] })
    .expect(201);
  const link = await as(u.admin).post(`${orgUrl()}/persons/${person}/invitations`).expect(201);
  await as(u.tenant)
    .post('/api/v1/invitations/accept')
    .send({ token: link.body.token })
    .expect(200);
});

afterAll(async () => {
  await app?.close();
});

describe('notifications', () => {
  it('tell residents about decisions on their bookings and requests, with an email waiting', async () => {
    const area = (
      await as(u.admin)
        .post(`${pUrl()}/common-areas`)
        .send({ name: 'Hall', type: 'FUNCTION_ROOM' })
        .expect(201)
    ).body.id;
    const hall = (
      await as(u.mgr)
        .post(`${pUrl()}/facilities`)
        .send({
          commonAreaId: area,
          slotMinutes: 60,
          approvalRequired: true,
          openingHours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            opensAt: '00:00',
            closesAt: '24:00',
          })),
        })
        .expect(201)
    ).body.facility.id;
    const day = new Date(Date.now() + 5 * 3_600_000 + 3 * 86_400_000).toISOString().slice(0, 10);
    const booking = (
      await as(u.tenant)
        .post(`${pUrl()}/units/${unit}/facility-bookings`)
        .send({ facilityId: hall, startsAt: `${day}T18:00:00+05:00` })
        .expect(201)
    ).body.booking;
    expect((await feed(u.tenant)).body.data).toEqual([]);
    await as(u.mgr).post(`${pUrl()}/facility-bookings/${booking.id}/approve`).expect(200);

    const request_ = (
      await as(u.tenant)
        .post(`${pUrl()}/units/${unit}/maintenance-requests`)
        .send({ category: 'PLUMBING', title: 'Leaking tap', description: 'Drips all night' })
        .expect(201)
    ).body.request;
    await as(u.mgr)
      .post(`${pUrl()}/maintenance/requests/${request_.id}/accept`)
      .send({})
      .expect(200);

    const mine = (await feed(u.tenant)).body;
    expect(mine.unread).toBe(2);
    expect(mine.data.map((n: { kind: string }) => n.kind)).toEqual([
      'maintenance.request.accepted',
      'facility.booking.approved',
    ]);
    expect(mine.data[1]).toMatchObject({
      title: 'Booking approved',
      link: `/organisations/${org}/properties/${P}/units/${unit}/facilities`,
    });

    const deliveries = (await as(u.mgr).get(`${pUrl()}/notification-deliveries`).expect(200)).body
      .data;
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({
      channel: 'EMAIL',
      status: 'PENDING',
      attempts: 0,
      recipient: 'tenant',
    });
    await as(u.tenant).get(`${pUrl()}/notification-deliveries`).expect(404);
  });

  it('send urgent announcements by email too; feeds are private and marked read', async () => {
    const draft = (
      await as(u.mgr)
        .post(`${pUrl()}/announcements`)
        .send({
          title: 'Gas leak drill',
          body: 'Leave by the stairs at 10:00.',
          audience: 'RESIDENTS',
          priority: 'URGENT',
        })
        .expect(201)
    ).body.announcement.id;
    await as(u.mgr).post(`${pUrl()}/announcements/${draft}/publish`).expect(200);
    const urgent = (await feed(u.tenant)).body.data[0];
    expect(urgent).toMatchObject({
      kind: 'announcement.urgent',
      urgent: true,
      link: `/organisations/${org}/inbox`,
    });

    expect((await feed(u.stranger)).body.data).toEqual([]);
    await as(u.stranger).post(`${orgUrl()}/notifications/${urgent.id}/read`).expect(404);
    await as(u.tenant).post(`${orgUrl()}/notifications/${urgent.id}/read`).expect(204);
    expect((await feed(u.tenant)).body.unread).toBe(2);
    expect(
      (await as(u.tenant).post(`${orgUrl()}/notifications/read-all`).expect(200)).body.marked,
    ).toBe(2);
    expect((await feed(u.tenant)).body.unread).toBe(0);
  });
});

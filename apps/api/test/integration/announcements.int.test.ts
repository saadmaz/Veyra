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
 * Announcements over HTTP (Phase 10 Part 1): a manager drafts and publishes to residents, one
 * building, staff or everyone; each recipient finds it in their inbox, reads and acknowledges it;
 * the manager sees who did; withdrawn announcements leave inboxes; guards and residents cannot
 * publish; people outside the audience see nothing.
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

const NAMES = ['admin', 'mgr', 'guard', 'ownerA', 'tenantB', 'stranger'] as const;
const u = {} as Record<(typeof NAMES)[number], TestUser>;
let org: string;
let P: string;
let towerB: string;
const orgUrl = () => `/api/v1/organisations/${org}`;
const aUrl = (path = '') => `${orgUrl()}/properties/${P}/announcements${path ? `/${path}` : ''}`;
const inbox = (user: TestUser) => as(user).get(`${orgUrl()}/inbox`).expect(200);

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

  for (const name of NAMES) u[name] = await signUp(name);
  org = (
    await as(u.admin)
      .post('/api/v1/organisations')
      .send({
        name: 'News Org',
        slug: `news-${run}`,
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
        name: 'News Tower',
        code: 'NT',
        type: 'CONDOMINIUM',
        addressLine1: '1 Road',
        city: 'Karachi',
      })
      .expect(201)
  ).body.id;
  for (const [user, role] of [
    [u.mgr, 'PROPERTY_MANAGER'],
    [u.guard, 'SECURITY_GUARD'],
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
  const towerA = (
    await as(u.admin).post(`${pUrl}/buildings`).send({ name: 'Tower A', code: 'A' }).expect(201)
  ).body.id;
  towerB = (
    await as(u.admin).post(`${pUrl}/buildings`).send({ name: 'Tower B', code: 'B' }).expect(201)
  ).body.id;
  const unitA = (
    await as(u.admin)
      .post(`${pUrl}/units`)
      .send({ number: 'A1', type: 'APARTMENT', buildingId: towerA })
      .expect(201)
  ).body.id;
  const unitB = (
    await as(u.admin)
      .post(`${pUrl}/units`)
      .send({ number: 'B1', type: 'APARTMENT', buildingId: towerB })
      .expect(201)
  ).body.id;
  const resident = async (user: TestUser, fullName: string) => {
    const person = (
      await as(u.admin).post(`${pUrl}/persons`).send({ fullName, email: user.email }).expect(201)
    ).body.id as string;
    const invited = await as(u.admin).post(`${orgUrl()}/persons/${person}/invitations`).expect(201);
    await as(user)
      .post('/api/v1/invitations/accept')
      .send({ token: invited.body.token })
      .expect(200);
    return person;
  };
  const owner = await resident(u.ownerA, 'Olu Owner');
  await as(u.admin)
    .post(`${pUrl}/units/${unitA}/owners`)
    .send({
      effectiveFrom: '2026-01-01',
      owners: [{ personId: owner, shareNumerator: 1, shareDenominator: 1 }],
    })
    .expect(200);
  const tenant = await resident(u.tenantB, 'Tara Tenant');
  await as(u.admin)
    .post(`${pUrl}/units/${unitB}/tenancies`)
    .send({ startDate: '2026-01-01', occupants: [{ personId: tenant, isPrimary: true }] })
    .expect(201);
});

afterAll(async () => {
  await app?.close();
});

const draftFor = async (body: Record<string, unknown>) =>
  (
    await as(u.mgr)
      .post(aUrl())
      .send({ title: 'Water off', body: 'Friday 10:00 to 14:00.', ...body })
      .expect(201)
  ).body.announcement.id as string;

describe('announcements', () => {
  it('reach residents, are read and acknowledged, and the manager sees who did', async () => {
    const id = await draftFor({
      audience: 'RESIDENTS',
      requiresAcknowledgement: true,
      priority: 'URGENT',
    });
    expect((await inbox(u.ownerA)).body.data).toEqual([]);
    const published = (
      await as(u.mgr)
        .post(aUrl(`${id}/publish`))
        .expect(200)
    ).body;
    expect(published.announcement).toMatchObject({
      status: 'PUBLISHED',
      publishedBy: 'mgr',
      delivery: { recipients: 2 },
    });
    expect(published.recipients.map((r: { name: string }) => r.name).sort()).toEqual([
      'ownerA',
      'tenantB',
    ]);

    const owner = (await inbox(u.ownerA)).body.data;
    expect(owner).toHaveLength(1);
    expect(owner[0]).toMatchObject({
      readAt: null,
      announcement: { title: 'Water off', priority: 'URGENT' },
    });
    expect((await inbox(u.guard)).body.data).toEqual([]);
    expect((await inbox(u.stranger)).body.data).toEqual([]);

    const acked = (await as(u.ownerA).post(`${orgUrl()}/inbox/${id}/acknowledge`).expect(200)).body;
    expect(acked.readAt).not.toBeNull();
    expect(acked.acknowledgedAt).not.toBeNull();
    await as(u.stranger).post(`${orgUrl()}/inbox/${id}/read`).expect(404);

    const detail = (await as(u.mgr).get(aUrl(id)).expect(200)).body;
    expect(detail.announcement.delivery).toEqual({ recipients: 2, read: 1, acknowledged: 1 });
    await as(u.mgr).patch(aUrl(id)).send({ title: 'Changed' }).expect(409);
  });

  it('reach one building, or staff, or everyone', async () => {
    const building = await draftFor({ audience: 'BUILDING_RESIDENTS', buildingId: towerB });
    expect(
      (
        await as(u.mgr)
          .post(aUrl(`${building}/publish`))
          .expect(200)
      ).body.recipients.map((r: { name: string }) => r.name),
    ).toEqual(['tenantB']);
    const staff = await draftFor({ audience: 'STAFF', title: 'Shift change' });
    const staffNames = (
      await as(u.mgr)
        .post(aUrl(`${staff}/publish`))
        .expect(200)
    ).body.recipients.map((r: { name: string }) => r.name);
    expect(staffNames).toEqual(expect.arrayContaining(['guard', 'mgr', 'admin']));
    expect(staffNames).not.toContain('ownerA');
    const everyone = await draftFor({ audience: 'EVERYONE', title: 'Lift works' });
    expect(
      (
        await as(u.mgr)
          .post(aUrl(`${everyone}/publish`))
          .expect(200)
      ).body.announcement.delivery.recipients,
    ).toBe(5);
    await as(u.mgr)
      .post(aUrl())
      .send({ title: 'x', body: 'y', audience: 'BUILDING_RESIDENTS' })
      .expect(400);
  });

  it('are withdrawn with a reason and leave inboxes; only managers publish', async () => {
    const id = await draftFor({ audience: 'RESIDENTS', title: 'Pool closed' });
    await as(u.guard)
      .post(aUrl(`${id}/publish`))
      .expect(403);
    await as(u.ownerA)
      .post(aUrl(`${id}/publish`))
      .expect(404);
    await as(u.mgr)
      .post(aUrl(`${id}/publish`))
      .expect(200);
    expect(
      (await inbox(u.tenantB)).body.data.map(
        (i: { announcement: { id: string } }) => i.announcement.id,
      ),
    ).toContain(id);
    await as(u.mgr)
      .post(aUrl(`${id}/withdraw`))
      .send({})
      .expect(400);
    await as(u.mgr)
      .post(aUrl(`${id}/withdraw`))
      .send({ reason: 'Sent by mistake' })
      .expect(200);
    expect(
      (await inbox(u.tenantB)).body.data.map(
        (i: { announcement: { id: string } }) => i.announcement.id,
      ),
    ).not.toContain(id);
    await as(u.ownerA).post(`${orgUrl()}/inbox/${id}/read`).expect(404);
  });
});

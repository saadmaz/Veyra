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
 * Staff operations over HTTP (Phase 9 Part 3): supervisors keep departments and members and
 * schedule shifts for staff who work at the property; a person's shifts never overlap; staff see
 * only their own shifts, start them and end them with a handover note that the next shift of the
 * department reads; guards cannot manage.
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

const NAMES = ['admin', 'supervisor', 'guard', 'guard2', 'finance'] as const;
const u = {} as Record<(typeof NAMES)[number], TestUser>;
let org: string;
let P: string;
let security: string;
const orgUrl = () => `/api/v1/organisations/${org}`;
const sUrl = (path: string) => `${orgUrl()}/properties/${P}/staff/${path}`;
const myUrl = (path = '') => `${orgUrl()}/properties/${P}/my-shifts${path ? `/${path}` : ''}`;
const at = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

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
        name: 'Staff Org',
        slug: `staff-${run}`,
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
        name: 'Staff Tower',
        code: 'SF',
        type: 'CONDOMINIUM',
        addressLine1: '1 Road',
        city: 'Karachi',
      })
      .expect(201)
  ).body.id;
  for (const [user, role, propertyId] of [
    [u.supervisor, 'SECURITY_SUPERVISOR', P],
    [u.guard, 'SECURITY_GUARD', P],
    [u.guard2, 'SECURITY_GUARD', P],
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
});

afterAll(async () => {
  await app?.close();
});

describe('departments', () => {
  it('are kept by supervisors, with members who work at the property', async () => {
    security = (
      await as(u.supervisor).post(sUrl('departments')).send({ name: 'Security' }).expect(201)
    ).body.id;
    await as(u.supervisor).post(sUrl('departments')).send({ name: 'security' }).expect(409);
    await as(u.guard).post(sUrl('departments')).send({ name: 'Guards' }).expect(403);

    const people = (await as(u.supervisor).get(sUrl('people')).expect(200)).body.data;
    expect(people.map((p: { userId: string }) => p.userId)).toEqual(
      expect.arrayContaining([u.guard.id, u.guard2.id, u.supervisor.id]),
    );
    expect(people.map((p: { userId: string }) => p.userId)).not.toContain(u.finance.id);
    await as(u.supervisor)
      .post(sUrl(`departments/${security}/members`))
      .send({ userId: u.finance.id })
      .expect(422);
    for (const user of [u.guard, u.guard2]) {
      await as(u.supervisor)
        .post(sUrl(`departments/${security}/members`))
        .send({ userId: user.id })
        .expect(201);
    }
    const list = (await as(u.supervisor).get(sUrl('departments')).expect(200)).body.data;
    expect(list[0].members.map((m: { name: string }) => m.name).sort()).toEqual([
      'guard',
      'guard2',
    ]);
  });
});

describe('shifts', () => {
  it('are scheduled for members without overlaps, and seen only by the person', async () => {
    const shift = await as(u.supervisor)
      .post(sUrl('shifts'))
      .send({ departmentId: security, userId: u.guard.id, startsAt: at(-0.5), endsAt: at(7.5) })
      .expect(201);
    expect(shift.body).toMatchObject({ status: 'SCHEDULED', person: { userId: u.guard.id } });
    const clash = await as(u.supervisor)
      .post(sUrl('shifts'))
      .send({ departmentId: security, userId: u.guard.id, startsAt: at(7), endsAt: at(10) })
      .expect(409);
    expect(clash.body.error.code).toBe('SHIFT_OVERLAP');
    await as(u.supervisor)
      .post(sUrl('shifts'))
      .send({ departmentId: security, userId: u.supervisor.id, startsAt: at(20), endsAt: at(28) })
      .expect(422);
    await as(u.supervisor)
      .post(sUrl('shifts'))
      .send({ departmentId: security, userId: u.guard.id, startsAt: at(20), endsAt: at(45) })
      .expect(400);

    const mine = (await as(u.guard).get(myUrl()).expect(200)).body.data;
    expect(mine.map((s: { id: string }) => s.id)).toContain(shift.body.id);
    await as(u.guard2).get(myUrl(shift.body.id)).expect(404);
    await as(u.guard).get(sUrl('shifts')).expect(403);
  });

  it('start, end with a handover note, and pass the note to the next shift', async () => {
    const first = (await as(u.guard).get(myUrl()).expect(200)).body.data.find(
      (s: { status: string }) => s.status === 'SCHEDULED',
    );
    const started = await as(u.guard)
      .post(myUrl(`${first.id}/start`))
      .expect(200);
    expect(started.body.shift.status).toBe('STARTED');
    await as(u.supervisor)
      .post(sUrl(`shifts/${first.id}/cancel`))
      .send({ reason: 'Late' })
      .expect(409);
    await as(u.guard)
      .post(myUrl(`${first.id}/end`))
      .send({})
      .expect(400);
    const ended = await as(u.guard)
      .post(myUrl(`${first.id}/end`))
      .send({ handoverNote: 'Gate 2 camera offline; contractor due at 9.' })
      .expect(200);
    expect(ended.body.shift).toMatchObject({
      status: 'ENDED',
      handoverNote: 'Gate 2 camera offline; contractor due at 9.',
    });

    const next = (
      await as(u.supervisor)
        .post(sUrl('shifts'))
        .send({ departmentId: security, userId: u.guard2.id, startsAt: at(8), endsAt: at(16) })
        .expect(201)
    ).body;
    const view = (await as(u.guard2).get(myUrl(next.id)).expect(200)).body;
    expect(view.previousHandover).toMatchObject({
      note: 'Gate 2 camera offline; contractor due at 9.',
      by: 'guard',
    });
    // Too early to start.
    expect(
      (
        await as(u.guard2)
          .post(myUrl(`${next.id}/start`))
          .expect(409)
      ).body.error.code,
    ).toBe('NOT_YET');
    const handovers = (
      await as(u.supervisor)
        .get(sUrl(`departments/${security}/handovers`))
        .expect(200)
    ).body.data;
    expect(handovers).toHaveLength(1);
  });

  it('are moved or cancelled with a reason, and block archiving and removal while live', async () => {
    const later = (
      await as(u.supervisor)
        .post(sUrl('shifts'))
        .send({ departmentId: security, userId: u.guard.id, startsAt: at(30), endsAt: at(38) })
        .expect(201)
    ).body;
    const moved = await as(u.supervisor)
      .patch(sUrl(`shifts/${later.id}`))
      .send({ startsAt: at(32), endsAt: at(40) })
      .expect(200);
    expect(
      Math.round((Date.parse(moved.body.startsAt) - Date.parse(later.startsAt)) / 60_000),
    ).toBe(120);
    expect(
      (
        await as(u.supervisor)
          .post(sUrl(`departments/${security}/archive`))
          .expect(409)
      ).body.error.code,
    ).toBe('SHIFTS_IN_THE_WAY');
    await as(u.supervisor)
      .post(sUrl(`departments/${security}/members/${u.guard.id}/remove`))
      .expect(409);
    await as(u.supervisor)
      .post(sUrl(`shifts/${later.id}/cancel`))
      .send({})
      .expect(400);
    const cancelled = await as(u.supervisor)
      .post(sUrl(`shifts/${later.id}/cancel`))
      .send({ reason: 'Covered by agency staff' })
      .expect(200);
    expect(cancelled.body).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Covered by agency staff',
    });
    await as(u.supervisor)
      .post(sUrl(`departments/${security}/members/${u.guard.id}/remove`))
      .expect(200);
  });
});

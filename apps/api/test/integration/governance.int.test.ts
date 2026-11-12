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
 * Governance over HTTP (Phase 11 Part 2): a manager forms a committee and seats people who hold
 * the Committee member role (one chair at a time); schedules a meeting with an agenda, holds it,
 * records resolutions and approves the minutes, after which the meeting is final; committee
 * members read everything and change nothing; other staff see nothing.
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

const u = {} as Record<'admin' | 'mgr' | 'alice' | 'bob' | 'guard', TestUser>;
let org: string;
let P: string;
const orgUrl = () => `/api/v1/organisations/${org}`;
const cUrl = (path = '') => `${orgUrl()}/properties/${P}/committees${path ? `/${path}` : ''}`;
const mUrl = (path = '') => `${orgUrl()}/properties/${P}/meetings${path ? `/${path}` : ''}`;
const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();
const NO_DOCUMENT = '0190a0a0-0000-7000-8000-000000000000';

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

  for (const name of ['admin', 'mgr', 'alice', 'bob', 'guard'] as const)
    u[name] = await signUp(name);
  org = (
    await as(u.admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Governance Org',
        slug: `governance-${run}`,
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
        name: 'Governance Tower',
        code: 'GT',
        type: 'CONDOMINIUM',
        addressLine1: '1 Road',
        city: 'Karachi',
      })
      .expect(201)
  ).body.id;
  for (const [user, role] of [
    [u.mgr, 'PROPERTY_MANAGER'],
    [u.alice, 'COMMITTEE_MEMBER'],
    [u.bob, 'COMMITTEE_MEMBER'],
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
});

afterAll(async () => {
  await app?.close();
});

describe('governance', () => {
  let board: string;

  it('seat committee members, one chair at a time, and end terms once', async () => {
    await as(u.alice).post(cUrl()).send({ name: 'Board' }).expect(403);
    board = (
      await as(u.mgr).post(cUrl()).send({ name: 'Board', purpose: 'Runs the building' }).expect(201)
    ).body.id;
    await as(u.mgr).post(cUrl()).send({ name: 'board' }).expect(409);
    await as(u.mgr)
      .post(cUrl(`${board}/seats`))
      .send({ userId: u.guard.id, position: 'MEMBER', termStart: '2026-01-01' })
      .expect(422);
    const seated = (
      await as(u.mgr)
        .post(cUrl(`${board}/seats`))
        .send({ userId: u.alice.id, position: 'CHAIR', termStart: '2026-01-01' })
        .expect(201)
    ).body;
    expect(seated.seats[0]).toMatchObject({ name: 'alice', position: 'CHAIR', current: true });
    await as(u.mgr)
      .post(cUrl(`${board}/seats`))
      .send({ userId: u.bob.id, position: 'CHAIR', termStart: '2026-03-01' })
      .expect(409);
    await as(u.mgr)
      .post(cUrl(`${board}/seats`))
      .send({ userId: u.bob.id, position: 'SECRETARY', termStart: '2026-03-01' })
      .expect(201);
    const candidates = (await as(u.mgr).get(cUrl('candidates')).expect(200)).body.data;
    expect(candidates.map((c: { name: string }) => c.name)).toEqual(
      expect.arrayContaining(['alice', 'bob']),
    );
    const seat = seated.seats[0].id;
    const ended = (
      await as(u.mgr)
        .post(cUrl(`${board}/seats/${seat}/end`))
        .send({ termEnd: '2026-06-30' })
        .expect(200)
    ).body;
    expect(ended.seats.find((s: { name: string }) => s.name === 'alice')).toMatchObject({
      termEnd: '2026-06-30',
      current: false,
    });
    await as(u.mgr)
      .post(cUrl(`${board}/seats/${seat}/end`))
      .send({ termEnd: '2026-07-31' })
      .expect(409);
  });

  it('hold a meeting, record resolutions, and approve the minutes once', async () => {
    const m = (
      await as(u.mgr)
        .post(cUrl(`${board}/meetings`))
        .send({
          title: 'Annual meeting',
          scheduledAt: hourAgo(),
          location: 'Lobby',
          agenda: [{ title: 'Budget' }, { title: 'Lobby repaint', details: 'Three quotes' }],
        })
        .expect(201)
    ).body;
    expect(m.agenda.map((a: { position: number }) => a.position)).toEqual([1, 2]);
    await as(u.mgr)
      .post(mUrl(`${m.id}/resolutions`))
      .send({ title: 'Repaint', text: 'Approved.', outcome: 'PASSED' })
      .expect(409);
    await as(u.mgr)
      .post(mUrl(`${m.id}/agenda`))
      .send({ title: 'Any other business' })
      .expect(200);
    await as(u.mgr)
      .post(mUrl(`${m.id}/held`))
      .expect(200);
    await as(u.mgr)
      .post(mUrl(`${m.id}/agenda`))
      .send({ title: 'Late item' })
      .expect(409);
    await as(u.mgr)
      .post(mUrl(`${m.id}/minutes/approve`))
      .expect(409);
    const withResolution = (
      await as(u.mgr)
        .post(mUrl(`${m.id}/resolutions`))
        .send({
          title: 'Repaint the lobby',
          text: 'The lobby is repainted within the approved budget.',
          outcome: 'PASSED',
          votesFor: 4,
          votesAgainst: 1,
        })
        .expect(201)
    ).body;
    expect(withResolution.resolutions[0].reference).toMatch(/^RES-\d{6}$/);
    await as(u.mgr)
      .post(mUrl(`${m.id}/resolutions`))
      .send({ title: 'X', text: 'Y', outcome: 'PASSED', documentId: NO_DOCUMENT })
      .expect(422);
    await as(u.mgr)
      .post(mUrl(`${m.id}/minutes`))
      .send({ minutes: 'Present: four members.' })
      .expect(200);
    const approved = (
      await as(u.mgr)
        .post(mUrl(`${m.id}/minutes/approve`))
        .expect(200)
    ).body;
    expect(approved).toMatchObject({ status: 'HELD', minutesApprovedBy: 'mgr' });
    await as(u.mgr)
      .post(mUrl(`${m.id}/minutes`))
      .send({ minutes: 'Changed.' })
      .expect(409);

    const read = (await as(u.alice).get(mUrl(m.id)).expect(200)).body;
    expect(read.minutes).toBe('Present: four members.');
    await as(u.alice)
      .post(mUrl(`${m.id}/minutes`))
      .send({ minutes: 'Mine.' })
      .expect(403);
    await as(u.guard).get(mUrl()).expect(403);
  });

  it('cancel a meeting with a reason, never hold one early, and dissolve the committee', async () => {
    const later = (
      await as(u.mgr)
        .post(cUrl(`${board}/meetings`))
        .send({ title: 'Next', scheduledAt: new Date(Date.now() + 7 * 86_400_000).toISOString() })
        .expect(201)
    ).body;
    await as(u.mgr)
      .post(mUrl(`${later.id}/held`))
      .expect(409);
    await as(u.mgr)
      .post(cUrl(`${board}/dissolve`))
      .expect(409);
    await as(u.mgr)
      .post(mUrl(`${later.id}/cancel`))
      .send({ reason: 'No quorum' })
      .expect(200);
    await as(u.mgr)
      .post(mUrl(`${later.id}/held`))
      .expect(409);
    const gone = (
      await as(u.mgr)
        .post(cUrl(`${board}/dissolve`))
        .expect(200)
    ).body;
    expect(gone.status).toBe('DISSOLVED');
    await as(u.mgr)
      .post(cUrl(`${board}/meetings`))
      .send({ title: 'After', scheduledAt: hourAgo() })
      .expect(409);
    const list = (await as(u.alice).get(`${mUrl()}?committeeId=${board}`).expect(200)).body.data;
    expect(list).toHaveLength(2);
  });
});

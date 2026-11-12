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
 * Incidents over HTTP (Phase 11 Part 1): a guard reports a critical fire and the managers are
 * alerted; sensitive incidents are seen only by managers and their reporter; only managers run
 * the response, which needs an outcome to resolve and every follow-up done to close; the person
 * given a follow-up can mark it done; escalation contacts are listed for the kind of incident.
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
const iUrl = (path = '') => `${orgUrl()}/properties/${P}/incidents${path ? `/${path}` : ''}`;
const cUrl = () => `${orgUrl()}/properties/${P}/escalation-contacts`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
const names = (rows: { name: string }[]) => rows.map((r) => r.name);

const report = (user: TestUser, over: Record<string, unknown> = {}) =>
  as(user)
    .post(iUrl())
    .send({
      category: 'SECURITY',
      severity: 'LOW',
      title: 'Gate left open',
      description: 'The side gate was found open at night.',
      occurredAt: ago(30),
      locationDetail: 'Side gate',
      ...over,
    });

const contact = (over: Record<string, unknown>) => ({
  name: 'Someone',
  role: 'Helper',
  phone: '+92 21 555 0100',
  categories: [],
  position: 0,
  ...over,
});

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
        name: 'Incident Org',
        slug: `incidents-${run}`,
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
        name: 'Incident Tower',
        code: 'IT',
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

describe('incidents', () => {
  it('alert the managers when a critical one is reported, never in the future', async () => {
    const fire = (
      await report(u.guard, {
        category: 'FIRE',
        severity: 'CRITICAL',
        title: 'Smoke in the car park',
      }).expect(201)
    ).body;
    expect(fire.incident).toMatchObject({ status: 'OPEN', reportedBy: 'guard' });
    expect(fire.incident.reference).toMatch(/^IN-\d{6}$/);
    expect(fire.updates).toHaveLength(1);
    const feed = (await as(u.mgr).get(`${orgUrl()}/notifications`).expect(200)).body;
    expect(feed.data.map((n: { title: string }) => n.title)).toContain(
      `Critical incident ${fire.incident.reference}`,
    );
    const guardFeed = (await as(u.guard).get(`${orgUrl()}/notifications`).expect(200)).body;
    expect(guardFeed.data).toEqual([]);
    await report(u.guard, { occurredAt: new Date(Date.now() + 3_600_000).toISOString() }).expect(
      400,
    );
  });

  it('keep sensitive incidents to managers and their reporter', async () => {
    const secret = (await report(u.guard, { sensitive: true, title: 'Assault' }).expect(201)).body;
    const id = secret.incident.id;
    await as(u.guard).get(iUrl(id)).expect(200);
    await as(u.mgr).get(iUrl(id)).expect(200);
    await as(u.tech).get(iUrl(id)).expect(404);
    expect(ids((await as(u.tech).get(iUrl()).expect(200)).body.data)).not.toContain(id);
    await as(u.outsider).get(iUrl()).expect(404);
  });

  it('are run by managers: an outcome to resolve, every follow-up done to close', async () => {
    const id = (await report(u.guard).expect(201)).body.incident.id;
    await as(u.guard)
      .post(iUrl(`${id}/status`))
      .send({ status: 'RESPONDING' })
      .expect(403);
    await as(u.guard)
      .post(iUrl(`${id}/notes`))
      .send({ body: 'Gate closed and locked.' })
      .expect(200);
    await as(u.mgr)
      .post(iUrl(`${id}/status`))
      .send({ status: 'RESPONDING' })
      .expect(200);
    await as(u.mgr)
      .post(iUrl(`${id}/status`))
      .send({ status: 'RESOLVED' })
      .expect(400);
    await as(u.mgr)
      .post(iUrl(`${id}/actions`))
      .send({ description: 'Fit a self-closing hinge', assignedToUserId: u.outsider.id })
      .expect(422);
    const withAction = (
      await as(u.mgr)
        .post(iUrl(`${id}/actions`))
        .send({ description: 'Fit a self-closing hinge', assignedToUserId: u.tech.id })
        .expect(201)
    ).body;
    const action = withAction.actions[0].id;
    await as(u.mgr)
      .post(iUrl(`${id}/status`))
      .send({ status: 'RESOLVED', outcome: 'Nothing taken; gate secured.' })
      .expect(200);
    await as(u.mgr)
      .post(iUrl(`${id}/status`))
      .send({ status: 'CLOSED' })
      .expect(409);
    await as(u.guard)
      .post(iUrl(`${id}/actions/${action}/done`))
      .expect(404);
    const done = (
      await as(u.tech)
        .post(iUrl(`${id}/actions/${action}/done`))
        .expect(200)
    ).body;
    expect(done.actions[0]).toMatchObject({ doneBy: 'tech' });
    const closed = (
      await as(u.mgr)
        .post(iUrl(`${id}/status`))
        .send({ status: 'CLOSED' })
        .expect(200)
    ).body;
    expect(closed.incident).toMatchObject({
      status: 'CLOSED',
      outcome: 'Nothing taken; gate secured.',
    });
    expect(
      closed.updates.map((x: { kind: string; toStatus: string | null }) => x.toStatus ?? x.kind),
    ).toEqual(['OPEN', 'NOTE', 'RESPONDING', 'RESOLVED', 'CLOSED']);
    await as(u.guard)
      .post(iUrl(`${id}/notes`))
      .send({ body: 'Late.' })
      .expect(409);
    expect(ids((await as(u.mgr).get(iUrl()).expect(200)).body.data)).not.toContain(id);
    expect(ids((await as(u.mgr).get(`${iUrl()}?status=all`).expect(200)).body.data)).toContain(id);
  });

  it('list escalation contacts for the kind of incident; only managers keep them', async () => {
    await as(u.guard).post(cUrl()).send(contact({})).expect(403);
    await as(u.mgr)
      .post(cUrl())
      .send(contact({ name: 'City Fire Station', categories: ['FIRE'], position: 1 }))
      .expect(201);
    const shield = (
      await as(u.mgr)
        .post(cUrl())
        .send(contact({ name: 'Shield Security', email: 'Duty@Shield.example.test', position: 2 }))
        .expect(201)
    ).body;
    expect(shield.email).toBe('duty@shield.example.test');
    expect(
      names((await as(u.guard).get(`${cUrl()}?category=SECURITY`).expect(200)).body.data),
    ).toEqual(['Shield Security']);
    const fire = (await report(u.guard, { category: 'FIRE' }).expect(201)).body;
    expect(names(fire.contacts)).toEqual(['City Fire Station', 'Shield Security']);
    await as(u.mgr).patch(`${cUrl()}/${shield.id}`).send({ active: false }).expect(200);
    expect((await as(u.guard).get(`${cUrl()}?category=SECURITY`).expect(200)).body.data).toEqual(
      [],
    );
  });
});

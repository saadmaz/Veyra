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
 * Checklists over HTTP (Phase 9 Part 4): a supervisor writes a template and gives it to a guard;
 * the guard answers every check (a failed one with a note) and submits; the supervisor returns it
 * once with a note and then verifies it; nobody verifies their own checklist; other people's
 * checklists are 404; templates changed later do not change checklists already given.
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
  put: (url: string) => http().put(url).set('Cookie', user.cookie),
});

const u = {} as Record<'admin' | 'supervisor' | 'guard' | 'guard2', TestUser>;
let org: string;
let P: string;
const orgUrl = () => `/api/v1/organisations/${org}`;
const sUrl = (path: string) => `${orgUrl()}/properties/${P}/staff/${path}`;
const myUrl = (path = '') => `${orgUrl()}/properties/${P}/my-checklists${path ? `/${path}` : ''}`;

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

  for (const name of ['admin', 'supervisor', 'guard', 'guard2'] as const)
    u[name] = await signUp(name);
  org = (
    await as(u.admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Check Org',
        slug: `check-${run}`,
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
        name: 'Check Tower',
        code: 'CT',
        type: 'CONDOMINIUM',
        addressLine1: '1 Road',
        city: 'Karachi',
      })
      .expect(201)
  ).body.id;
  for (const [user, role] of [
    [u.supervisor, 'SECURITY_SUPERVISOR'],
    [u.guard, 'SECURITY_GUARD'],
    [u.guard2, 'SECURITY_GUARD'],
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

describe('checklists', () => {
  it('go from template to verification, with a return in between', async () => {
    const template = (
      await as(u.supervisor)
        .post(sUrl('checklist-templates'))
        .send({
          title: 'Night patrol',
          items: ['Gate 1 locked', 'Fire exits clear', 'Pool gate closed'],
        })
        .expect(201)
    ).body;
    await as(u.guard)
      .post(sUrl('checklist-templates'))
      .send({ title: 'Mine', items: ['x'] })
      .expect(403);

    const given = (
      await as(u.supervisor)
        .post(sUrl('checklists'))
        .send({ templateId: template.id, assignedToUserId: u.guard.id, dueOn: '2026-12-01' })
        .expect(201)
    ).body;
    expect(given).toMatchObject({
      status: 'OPEN',
      answered: 0,
      assignedTo: { userId: u.guard.id },
    });
    expect(given.items.map((i: { text: string }) => i.text)).toEqual(template.items);

    // Changing the template later does not change what was given.
    await as(u.supervisor)
      .patch(sUrl(`checklist-templates/${template.id}`))
      .send({ items: ['Something else'] })
      .expect(200);

    await as(u.guard2).get(myUrl(given.id)).expect(404);
    await as(u.guard)
      .put(myUrl(`${given.id}/items/1`))
      .send({ result: 'PASS' })
      .expect(200);
    await as(u.guard)
      .put(myUrl(`${given.id}/items/2`))
      .send({ result: 'FAIL' })
      .expect(400);
    await as(u.guard)
      .put(myUrl(`${given.id}/items/2`))
      .send({ result: 'FAIL', note: 'Boxes at exit B' })
      .expect(200);
    expect(
      (
        await as(u.guard)
          .post(myUrl(`${given.id}/submit`))
          .expect(422)
      ).body.error.code,
    ).toBe('INCOMPLETE');
    await as(u.guard)
      .put(myUrl(`${given.id}/items/9`))
      .send({ result: 'PASS' })
      .expect(404);
    const done = (
      await as(u.guard)
        .put(myUrl(`${given.id}/items/3`))
        .send({ result: 'NOT_APPLICABLE' })
        .expect(200)
    ).body;
    expect(done).toMatchObject({ answered: 3, failures: 1 });
    await as(u.guard)
      .post(myUrl(`${given.id}/submit`))
      .expect(200);
    await as(u.guard)
      .put(myUrl(`${given.id}/items/1`))
      .send({ result: 'FAIL', note: 'x' })
      .expect(409);

    const returned = (
      await as(u.supervisor)
        .post(sUrl(`checklists/${given.id}/return`))
        .send({ reason: 'Photograph exit B and clear it' })
        .expect(200)
    ).body;
    expect(returned).toMatchObject({
      status: 'OPEN',
      statusNote: 'Photograph exit B and clear it',
    });
    await as(u.guard)
      .put(myUrl(`${given.id}/items/2`))
      .send({ result: 'PASS', note: 'Cleared with the caretaker' })
      .expect(200);
    await as(u.guard)
      .post(myUrl(`${given.id}/submit`))
      .expect(200);
    const verified = (
      await as(u.supervisor)
        .post(sUrl(`checklists/${given.id}/verify`))
        .expect(200)
    ).body;
    expect(verified).toMatchObject({ status: 'VERIFIED', verifiedBy: 'supervisor', failures: 0 });
    await as(u.supervisor)
      .post(sUrl(`checklists/${given.id}/cancel`))
      .send({ reason: 'x' })
      .expect(409);
  });

  it('are never verified by the person who did them, and go only to staff of the property', async () => {
    const template = (
      await as(u.supervisor)
        .post(sUrl('checklist-templates'))
        .send({ title: 'Opening checks', items: ['Lights on'] })
        .expect(201)
    ).body;
    await as(u.supervisor)
      .post(sUrl('checklists'))
      .send({ templateId: template.id, assignedToUserId: u.admin.id, dueOn: '2026-12-01' })
      .expect(201);
    // The supervisor does one themselves; they cannot verify it.
    const own = (
      await as(u.supervisor)
        .post(sUrl('checklists'))
        .send({ templateId: template.id, assignedToUserId: u.supervisor.id, dueOn: '2026-12-01' })
        .expect(201)
    ).body;
    await as(u.supervisor)
      .put(`${orgUrl()}/properties/${P}/my-checklists/${own.id}/items/1`)
      .send({ result: 'PASS' })
      .expect(200);
    await as(u.supervisor)
      .post(`${orgUrl()}/properties/${P}/my-checklists/${own.id}/submit`)
      .expect(200);
    expect(
      (
        await as(u.supervisor)
          .post(sUrl(`checklists/${own.id}/verify`))
          .expect(403)
      ).body.error.code,
    ).toBe('OWN_CHECKLIST');
    await as(u.supervisor)
      .post(sUrl(`checklist-templates/${template.id}/archive`))
      .expect(200);
    await as(u.supervisor)
      .post(sUrl('checklists'))
      .send({ templateId: template.id, assignedToUserId: u.guard.id, dueOn: '2026-12-02' })
      .expect(409);
  });
});

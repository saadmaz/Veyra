import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { webhookSecret } from '@veyra/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadApiEnv } from '../../src/platform/config/env';
import { REDIS_CLIENT } from '../../src/platform/infrastructure/infrastructure.module';
import { RATE_LIMITER } from '../../src/platform/rate-limit/rate-limiter';
import { InMemoryRateLimiter } from '../support/in-memory-rate-limiter';

/**
 * Webhooks over HTTP (Phase 12 Part 3): organisation admins register HTTPS endpoints, see the
 * signing secret once (derived, so it matches what the worker signs with) and rotate it; reports
 * of incidents queue a delivery for each subscribed endpoint (sensitive ones never), a test event
 * reaches any active endpoint, and nobody else can see or manage endpoints.
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

const KEY = Buffer.alloc(32, 9);
const u = {} as Record<'admin' | 'mgr' | 'guard' | 'tech' | 'outsider', TestUser>;
let org: string;
let P: string;
const orgUrl = () => `/api/v1/organisations/${org}`;
const wUrl = (path = '') => `${orgUrl()}/webhooks${path ? `/${path}` : ''}`;
const report = (over: Record<string, unknown>) =>
  as(u.guard)
    .post(`${orgUrl()}/properties/${P}/incidents`)
    .send({
      category: 'SECURITY',
      severity: 'HIGH',
      title: 'Gate forced',
      description: 'The side gate lock was broken.',
      occurredAt: new Date(Date.now() - 600_000).toISOString(),
      ...over,
    })
    .expect(201);

beforeAll(async () => {
  const env = loadApiEnv({
    NODE_ENV: 'test',
    DATABASE_URL: inject('appDatabaseUrl'),
    REDIS_URL: 'redis://localhost:6379',
    API_CORS_ORIGINS: 'http://localhost:3000',
    WEBHOOK_SIGNING_KEY: KEY.toString('base64'),
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
        name: 'Webhook Org',
        slug: `webhooks-${run}`,
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
        name: 'Webhook Tower',
        code: 'WT',
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

describe('webhooks', () => {
  let endpoint: string;

  it('register HTTPS endpoints for admins, with a secret shown once', async () => {
    await as(u.mgr).get(wUrl()).expect(403);
    await as(u.admin)
      .post(wUrl())
      .send({ url: 'http://hooks.example.test/x', events: ['incident.reported'] })
      .expect(400);
    await as(u.admin)
      .post(wUrl())
      .send({ url: 'https://10.0.0.1/x', events: ['incident.reported'] })
      .expect(400);
    const created = (
      await as(u.admin)
        .post(wUrl())
        .send({
          url: 'https://hooks.example.test/veyra',
          events: ['incident.reported', 'approval_request.settled'],
          description: 'Building system',
        })
        .expect(201)
    ).body;
    endpoint = created.endpoint.id;
    expect(created.secret).toBe(webhookSecret(KEY, endpoint, 1));
    const listed = (await as(u.admin).get(wUrl()).expect(200)).body.data;
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
    const rotated = (
      await as(u.admin)
        .post(wUrl(`${endpoint}/rotate-secret`))
        .expect(200)
    ).body;
    expect(rotated.secret).toBe(webhookSecret(KEY, endpoint, 2));
    expect(rotated.secret).not.toBe(created.secret);
    expect((await as(u.admin).get(wUrl('events')).expect(200)).body.data).toContain(
      'incident.reported',
    );
  });

  it('queue a delivery when an incident is reported, never for sensitive ones', async () => {
    const incident = (await report({})).body.incident;
    await report({ sensitive: true, title: 'Assault' });
    const detail = (await as(u.admin).get(wUrl(endpoint)).expect(200)).body;
    expect(detail.deliveries).toHaveLength(1);
    expect(detail.deliveries[0]).toMatchObject({
      eventType: 'incident.reported',
      status: 'PENDING',
      attempts: 0,
    });
    expect(incident.reference).toMatch(/^IN-/);
  });

  it('send a test event, and stop when the endpoint is disabled', async () => {
    const tested = (
      await as(u.admin)
        .post(wUrl(`${endpoint}/test`))
        .expect(200)
    ).body;
    expect(tested.deliveries.map((d: { eventType: string }) => d.eventType)).toContain(
      'webhook.test',
    );
    await as(u.admin).patch(wUrl(endpoint)).send({ status: 'DISABLED' }).expect(200);
    await as(u.admin)
      .post(wUrl(`${endpoint}/test`))
      .expect(409);
    await report({});
    const after = (await as(u.admin).get(wUrl(endpoint)).expect(200)).body.deliveries;
    expect(
      after.filter((d: { eventType: string }) => d.eventType === 'incident.reported'),
    ).toHaveLength(1);
    await as(u.outsider).get(wUrl()).expect(404);
  });
});

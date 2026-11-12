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
 * Approvals over HTTP (Phase 11 Part 3): without a policy one manager approves; policies send
 * large expenses to a committee needing two approvals; nobody decides their own request, nor one
 * meant for others; one rejection (with a reason) settles it; only the requester withdraws;
 * approvers are told when a request arrives and the requester when it is settled.
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

const u = {} as Record<'admin' | 'mgr' | 'mm' | 'alice' | 'bob' | 'guard', TestUser>;
let org: string;
let P: string;
let board: string;
const orgUrl = () => `/api/v1/organisations/${org}`;
const cUrl = (path = '') => `${orgUrl()}/properties/${P}/committees${path ? `/${path}` : ''}`;
const pUrl = () => `${orgUrl()}/properties/${P}/approval-policies`;
const rUrl = (path = '') =>
  `${orgUrl()}/properties/${P}/approval-requests${path ? `/${path}` : ''}`;

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

  for (const name of ['admin', 'mgr', 'mm', 'alice', 'bob', 'guard'] as const)
    u[name] = await signUp(name);
  org = (
    await as(u.admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Approvals Org',
        slug: `approvals-${run}`,
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
        name: 'Approvals Tower',
        code: 'AT',
        type: 'CONDOMINIUM',
        addressLine1: '1 Road',
        city: 'Karachi',
      })
      .expect(201)
  ).body.id;
  for (const [user, role] of [
    [u.mgr, 'PROPERTY_MANAGER'],
    [u.mm, 'MAINTENANCE_MANAGER'],
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
  board = (await as(u.mgr).post(cUrl()).send({ name: 'Board' }).expect(201)).body.id;
  for (const member of [u.alice, u.bob]) {
    await as(u.mgr)
      .post(cUrl(`${board}/seats`))
      .send({
        userId: member.id,
        position: member === u.alice ? 'CHAIR' : 'MEMBER',
        termStart: '2026-01-01',
      })
      .expect(201);
  }
});

afterAll(async () => {
  await app?.close();
});

const ask = (body: Record<string, unknown>) =>
  as(u.mm)
    .post(rUrl())
    .send({
      title: 'New pump',
      description: 'The old pump failed.',
      requestType: 'EXPENSE',
      ...body,
    });

const titles = async (user: TestUser) =>
  (await as(user).get(`${orgUrl()}/notifications`).expect(200)).body.data.map(
    (n: { title: string }) => n.title,
  );

describe('approvals', () => {
  it('need one manager without a policy, and tell both sides', async () => {
    const r = (await ask({ requestType: 'OTHER', title: 'Paint the gate' }).expect(201)).body;
    expect(r).toMatchObject({
      status: 'PENDING',
      requiredApprovals: 1,
      approvers: 'MANAGERS',
      canDecide: false,
    });
    expect(r.reference).toMatch(/^AR-\d{6}$/);
    expect(await titles(u.mgr)).toContain('An approval is waiting for you');
    await as(u.mm)
      .post(rUrl(`${r.id}/decisions`))
      .send({ decision: 'APPROVE' })
      .expect(403);
    expect((await as(u.mgr).get(rUrl(r.id)).expect(200)).body.canDecide).toBe(true);
    const done = (
      await as(u.mgr)
        .post(rUrl(`${r.id}/decisions`))
        .send({ decision: 'APPROVE' })
        .expect(201)
    ).body;
    expect(done).toMatchObject({ status: 'APPROVED', approvals: 1 });
    expect(await titles(u.mm)).toContain('Your request was approved');
    await as(u.guard).get(rUrl()).expect(403);
  });

  it('send large expenses to the committee under the policy, two approvals needed', async () => {
    await as(u.guard)
      .post(pUrl())
      .send({ requestType: 'EXPENSE', requiredApprovals: 1, approvers: 'MANAGERS' })
      .expect(403);
    await as(u.mgr)
      .post(pUrl())
      .send({ requestType: 'EXPENSE', requiredApprovals: 1, approvers: 'MANAGERS' })
      .expect(201);
    const big = (
      await as(u.mgr)
        .post(pUrl())
        .send({
          requestType: 'EXPENSE',
          minAmount: '100000',
          requiredApprovals: 2,
          approvers: 'COMMITTEE',
          committeeId: board,
        })
        .expect(201)
    ).body;
    expect(big.minAmount).toEqual({ amountMinor: '10000000', currency: 'PKR' });
    await as(u.mgr)
      .post(pUrl())
      .send({
        requestType: 'EXPENSE',
        minAmount: '100000.00',
        requiredApprovals: 3,
        approvers: 'MANAGERS',
      })
      .expect(409);

    const small = (await ask({ amount: '50000' }).expect(201)).body;
    expect(small).toMatchObject({ approvers: 'MANAGERS', requiredApprovals: 1 });
    const r = (await ask({ amount: '250000.50' }).expect(201)).body;
    expect(r).toMatchObject({
      approvers: 'COMMITTEE',
      requiredApprovals: 2,
      amount: { amountMinor: '25000050', currency: 'PKR' },
    });
    expect(await titles(u.alice)).toContain('An approval is waiting for you');
    await as(u.mgr)
      .post(rUrl(`${r.id}/decisions`))
      .send({ decision: 'APPROVE' })
      .expect(403);
    const one = (
      await as(u.alice)
        .post(rUrl(`${r.id}/decisions`))
        .send({ decision: 'APPROVE' })
        .expect(201)
    ).body;
    expect(one).toMatchObject({ status: 'PENDING', approvals: 1, canDecide: false });
    await as(u.alice)
      .post(rUrl(`${r.id}/decisions`))
      .send({ decision: 'APPROVE' })
      .expect(409);
    const two = (
      await as(u.bob)
        .post(rUrl(`${r.id}/decisions`))
        .send({ decision: 'APPROVE' })
        .expect(201)
    ).body;
    expect(two.status).toBe('APPROVED');
    await ask({ amount: '1.123' }).expect(422);
  });

  it('reject with a reason at the first rejection; only the requester withdraws', async () => {
    const r = (await ask({ amount: '150000' }).expect(201)).body;
    await as(u.alice)
      .post(rUrl(`${r.id}/decisions`))
      .send({ decision: 'REJECT' })
      .expect(400);
    const rejected = (
      await as(u.alice)
        .post(rUrl(`${r.id}/decisions`))
        .send({ decision: 'REJECT', note: 'Get a second quote' })
        .expect(201)
    ).body;
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.decisions[0]).toMatchObject({ name: 'alice', note: 'Get a second quote' });
    expect(await titles(u.mm)).toContain('Your request was rejected');

    const w = (await ask({ requestType: 'POLICY', title: 'Pets allowed' }).expect(201)).body;
    await as(u.mgr)
      .post(rUrl(`${w.id}/withdraw`))
      .expect(404);
    expect(
      (
        await as(u.mm)
          .post(rUrl(`${w.id}/withdraw`))
          .expect(200)
      ).body.status,
    ).toBe('WITHDRAWN');
    await as(u.mgr)
      .post(rUrl(`${w.id}/decisions`))
      .send({ decision: 'APPROVE' })
      .expect(409);
    const pending = (await as(u.mgr).get(rUrl()).expect(200)).body.data;
    expect(pending.map((x: { id: string }) => x.id)).not.toContain(w.id);
    const all = (await as(u.mgr).get(`${rUrl()}?status=all`).expect(200)).body.data;
    expect(all.map((x: { id: string }) => x.id)).toContain(w.id);
  });
});

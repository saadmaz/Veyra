import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { base32Decode, stepAt, totpCode } from '../../src/modules/identity/domain/totp';
import { CLOCK } from '../../src/platform/clock';
import { loadApiEnv } from '../../src/platform/config/env';
import { REDIS_CLIENT } from '../../src/platform/infrastructure/infrastructure.module';
import { RATE_LIMITER } from '../../src/platform/rate-limit/rate-limiter';
import { InMemoryRateLimiter } from '../support/in-memory-rate-limiter';

/**
 * Two-step sign-in over HTTP with enforcement on (Phase 14 Part 2, ACCESS_CONTROL rule 7):
 * organisation admins and platform administrators read freely but change nothing until their
 * session is verified; codes come from an authenticator (TOTP), work once, and recovery codes work
 * once; turning it off needs a verified session and a code; other roles are not affected.
 */

const PASSWORD = 'correct horse battery staple';
const run = randomUUID().slice(0, 8);
let app: INestApplication;
/** Real time plus an offset the test moves forward to reach the next TOTP step. */
let offset = 0;
const clockNow = () => new Date(Date.now() + offset);
const http = () => request(app.getHttpServer());

interface TestUser {
  id: string;
  email: string;
  cookie: string;
}

const cookieOf = (res: request.Response) =>
  ((res.headers['set-cookie'] as unknown as string[])[0] as string).split(';')[0] as string;

async function signUp(name: string): Promise<TestUser> {
  const email = `${name}-${run}@example.test`;
  const res = await http()
    .post('/api/v1/auth/sign-up')
    .send({ email, password: PASSWORD, displayName: name })
    .expect(201);
  return { id: res.body.user.id, email, cookie: cookieOf(res) };
}

async function signIn(user: TestUser): Promise<string> {
  return cookieOf(
    await http()
      .post('/api/v1/auth/sign-in')
      .send({ email: user.email, password: PASSWORD })
      .expect(200),
  );
}

const as = (cookie: string) => ({
  get: (url: string) => http().get(url).set('Cookie', cookie),
  post: (url: string) => http().post(url).set('Cookie', cookie),
});

let admin: TestUser;
let mgr: TestUser;
let staff: TestUser;
let org: string;
let P: string;
let secret: string;
const code = () => totpCode(base32Decode(secret), stepAt(clockNow()));
const property = (name: string, code: string) => ({
  name,
  code,
  type: 'CONDOMINIUM',
  addressLine1: '1 Road',
  city: 'Karachi',
});

beforeAll(async () => {
  const env = loadApiEnv({
    NODE_ENV: 'test',
    DATABASE_URL: inject('appDatabaseUrl'),
    REDIS_URL: 'redis://localhost:6379',
    API_CORS_ORIGINS: 'http://localhost:3000',
    MFA_ENFORCEMENT: 'privileged',
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] })
    .overrideProvider(REDIS_CLIENT)
    .useValue({ quit: async () => 'OK' })
    .overrideProvider(RATE_LIMITER)
    .useValue(new InMemoryRateLimiter())
    .overrideProvider(CLOCK)
    .useValue({ now: clockNow })
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, env);
  await app.init();

  admin = await signUp('admin');
  mgr = await signUp('mgr');
  staff = await signUp('staff');
  org = (
    await as(admin.cookie)
      .post('/api/v1/organisations')
      .send({
        name: 'MFA Org',
        slug: `mfa-${run}`,
        countryCode: 'PK',
        defaultCurrency: 'PKR',
        defaultTimeZone: 'Asia/Karachi',
      })
      .expect(201)
  ).body.id;
  const owner = new pg.Client({ connectionString: inject('superuserDatabaseUrl') });
  await owner.connect();
  await owner.query(`INSERT INTO platform_admins (user_id) VALUES ($1)`, [staff.id]);
  await owner.end();
});

afterAll(async () => {
  await app?.close();
});

describe('two-step sign-in', () => {
  it('blocks privileged changes until it is set up, never reads', async () => {
    const orgUrl = `/api/v1/organisations/${org}`;
    await as(admin.cookie).get(orgUrl).expect(200);
    const refused = await as(admin.cookie)
      .post(`${orgUrl}/properties`)
      .send(property('First', 'FST'))
      .expect(403);
    expect(refused.body.error.code).toBe('MFA_SETUP_REQUIRED');
    const status = (await as(admin.cookie).get('/api/v1/auth/mfa').expect(200)).body;
    expect(status).toEqual({ enabled: false, sessionVerified: false, recoveryCodesLeft: 0 });
  });

  it('is turned on with a code from the authenticator, giving ten recovery codes', async () => {
    const setup = (await as(admin.cookie).post('/api/v1/auth/mfa/setup').expect(201)).body;
    secret = setup.secret;
    expect(setup.otpauthUri).toContain(`secret=${secret}`);
    await as(admin.cookie).post('/api/v1/auth/mfa/confirm').send({ code: '000000' }).expect(400);
    const confirmed = (
      await as(admin.cookie).post('/api/v1/auth/mfa/confirm').send({ code: code() }).expect(200)
    ).body;
    expect(confirmed.recoveryCodes).toHaveLength(10);
    const session = (await as(admin.cookie).get('/api/v1/auth/session').expect(200)).body;
    expect(session.user.mfaEnabled).toBe(true);
    expect(session.session.mfaVerified).toBe(true);
    P = (
      await as(admin.cookie)
        .post(`/api/v1/organisations/${org}/properties`)
        .send(property('First', 'FST'))
        .expect(201)
    ).body.id;
    await as(admin.cookie).post('/api/v1/auth/mfa/setup').expect(409);

    // A new session must be verified again; the same code never works twice.
    const second = await signIn(admin);
    const fresh = await as(second)
      .post(`/api/v1/organisations/${org}/properties/${P}/units`)
      .send({ number: 'A1', type: 'APARTMENT' })
      .expect(403);
    expect(fresh.body.error.code).toBe('MFA_REQUIRED');
    await as(second).post('/api/v1/auth/mfa/verify').send({ code: code() }).expect(400);
    offset += 30_000;
    await as(second).post('/api/v1/auth/mfa/verify').send({ code: code() }).expect(204);
    await as(second)
      .post(`/api/v1/organisations/${org}/properties/${P}/units`)
      .send({ number: 'A1', type: 'APARTMENT' })
      .expect(201);

    // A recovery code works once.
    const third = await signIn(admin);
    const recovery = confirmed.recoveryCodes[0].toLowerCase();
    await as(third).post('/api/v1/auth/mfa/verify').send({ recoveryCode: recovery }).expect(204);
    const fourth = await signIn(admin);
    await as(fourth).post('/api/v1/auth/mfa/verify').send({ recoveryCode: recovery }).expect(400);
    expect((await as(third).get('/api/v1/auth/mfa').expect(200)).body.recoveryCodesLeft).toBe(9);
  });

  it('leaves other roles alone, and binds platform administrators too', async () => {
    const orgUrl = `/api/v1/organisations/${org}`;
    const invited = await as(admin.cookie)
      .post(`${orgUrl}/invitations`)
      .send({ email: mgr.email, role: 'PROPERTY_MANAGER', propertyId: P })
      .expect(201);
    await as(mgr.cookie)
      .post('/api/v1/invitations/accept')
      .send({ token: invited.body.token })
      .expect(200);
    await as(mgr.cookie)
      .post(`${orgUrl}/properties/${P}/units`)
      .send({ number: 'B1', type: 'APARTMENT' })
      .expect(201);
    const platform = await as(staff.cookie)
      .post(`/api/v1/platform/organisations/${org}/suspend`)
      .send({ reason: 'test' })
      .expect(403);
    expect(platform.body.error.code).toBe('MFA_SETUP_REQUIRED');
  });

  it('is turned off only from a verified session with a current code', async () => {
    const unverified = await signIn(admin);
    offset += 30_000;
    await as(unverified).post('/api/v1/auth/mfa/disable').send({ code: code() }).expect(403);
    await as(admin.cookie).post('/api/v1/auth/mfa/disable').send({ code: '123456' }).expect(400);
    await as(admin.cookie).post('/api/v1/auth/mfa/disable').send({ code: code() }).expect(204);
    const status = (await as(admin.cookie).get('/api/v1/auth/mfa').expect(200)).body;
    expect(status.enabled).toBe(false);
    await as(admin.cookie)
      .post(`/api/v1/organisations/${org}/properties/${P}/units`)
      .send({ number: 'C1', type: 'APARTMENT' })
      .expect(403);
  });
});

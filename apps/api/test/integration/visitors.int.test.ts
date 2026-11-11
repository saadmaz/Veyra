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
 * Visitors and the gate over HTTP against the real database (Phase 5 Part 2): who may register
 * visitors, what guards see, admission rules (window, revocation, entries, host still resident),
 * two gates racing for the last entry, walk-ins, departures, the log and rate limits.
 */

const PASSWORD = 'correct horse battery staple';
let app: INestApplication;
const limiter = new InMemoryRateLimiter();
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

let admin: TestUser;
let guard: TestUser; // security guard of P
let supervisor: TestUser; // security supervisor of P
let guardQ: TestUser; // security guard of Q
let finance: TestUser;
let owner: TestUser; // owner of U1
let tenant: TestUser; // tenant of U2
let child: TestUser; // household member of U1
let org: string;
let P: string;
let Q: string;
const units: Record<string, string> = {};
const orgUrl = () => `/api/v1/organisations/${org}`;
const pUrl = (property = P) => `${orgUrl()}/properties/${property}`;
const uUrl = (unit: string, property = P) => `${pUrl(property)}/units/${units[unit]}`;
const invitationsUrl = (unit: string) => `${uUrl(unit)}/visitor-invitations`;
const gate = (path: string, property = P) => `${pUrl(property)}/gate/${path}`;

const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());

let tenancyId: string;

function visitor(overrides: Record<string, unknown> = {}) {
  return {
    category: 'GUEST',
    visitorName: 'Vera Visitor',
    visitorPhone: '+92 300 7654321',
    vehiclePlate: 'lea 1234',
    validFrom: hours(-1),
    validUntil: hours(2),
    ...overrides,
  };
}

async function register(user: TestUser, unit = 'U1', overrides: Record<string, unknown> = {}) {
  const res = await as(user).post(invitationsUrl(unit)).send(visitor(overrides)).expect(201);
  return res.body as {
    invitation: { id: string; createdByMe: boolean; entriesUsed: number };
    pass: { token: string; code: string };
  };
}

async function validate(body: Record<string, unknown>, user = guard, property = P) {
  return (await as(user).post(gate('validate', property)).send(body).expect(200)).body;
}

/** Creates a resident profile with the user's email, records it on a unit and links the login. */
async function makeResident(user: TestUser, unit: string, kind: 'owner' | 'tenant' | 'child') {
  const person = (
    await as(admin)
      .post(`${pUrl()}/persons`)
      .send({ fullName: `${kind} Resident`, email: user.email })
      .expect(201)
  ).body.id as string;
  if (kind === 'owner') {
    await as(admin)
      .post(`${uUrl(unit)}/owners`)
      .send({
        effectiveFrom: today(),
        owners: [{ personId: person, shareNumerator: 1, shareDenominator: 1 }],
      })
      .expect(200);
  } else if (kind === 'tenant') {
    tenancyId = (
      await as(admin)
        .post(`${uUrl(unit)}/tenancies`)
        .send({ startDate: today(), occupants: [{ personId: person, isPrimary: true }] })
        .expect(201)
    ).body.id;
  } else {
    await as(admin)
      .post(`${uUrl(unit)}/household`)
      .send({ personId: person, relationship: 'CHILD', validFrom: today() })
      .expect(201);
  }
  const invited = await as(admin).post(`${orgUrl()}/persons/${person}/invitations`).expect(201);
  await as(user).post('/api/v1/invitations/accept').send({ token: invited.body.token }).expect(200);
}

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
    .useValue(limiter)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, env);
  await app.init();

  [admin, guard, supervisor, guardQ, finance, owner, tenant, child] = (await Promise.all(
    ['admin', 'guard', 'supervisor', 'guardq', 'finance', 'owner', 'tenant', 'child'].map(signUp),
  )) as [TestUser, TestUser, TestUser, TestUser, TestUser, TestUser, TestUser, TestUser];
  org = (
    await as(admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Visitors Org',
        slug: `visitors-${run}`,
        countryCode: 'PK',
        defaultCurrency: 'PKR',
        defaultTimeZone: 'Asia/Karachi',
      })
      .expect(201)
  ).body.id;
  const property = async (code: string) =>
    (
      await as(admin)
        .post(`${orgUrl()}/properties`)
        .send({
          name: `Gatehouse ${code}`,
          code,
          type: 'CONDOMINIUM',
          addressLine1: '1 Road',
          city: 'Karachi',
        })
        .expect(201)
    ).body.id as string;
  P = await property('VP');
  Q = await property('VQ');
  // The new security roles are invited like any property-scoped role.
  for (const [user, role, propertyId] of [
    [guard, 'SECURITY_GUARD', P],
    [supervisor, 'SECURITY_SUPERVISOR', P],
    [guardQ, 'SECURITY_GUARD', Q],
    [finance, 'FINANCE_OFFICER', undefined],
  ] as const) {
    const invited = await as(admin)
      .post(`${orgUrl()}/invitations`)
      .send({ email: user.email, role, ...(propertyId ? { propertyId } : {}) })
      .expect(201);
    await as(user)
      .post('/api/v1/invitations/accept')
      .send({ token: invited.body.token })
      .expect(200);
  }
  for (const number of ['U1', 'U2', 'U3']) {
    units[number] = (
      await as(admin).post(`${pUrl()}/units`).send({ number, type: 'APARTMENT' }).expect(201)
    ).body.id;
  }
  await makeResident(owner, 'U1', 'owner');
  await makeResident(tenant, 'U2', 'tenant');
  await makeResident(child, 'U1', 'child');
});

afterAll(async () => {
  await app?.close();
});

describe('who may register visitors', () => {
  it('lets an owner register a visitor and returns the pass once', async () => {
    const { invitation, pass } = await register(owner);
    expect(invitation).toMatchObject({ createdByMe: true, entriesUsed: 0 });
    expect(pass.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pass.code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    const listed = await as(owner).get(invitationsUrl('U1')).expect(200);
    const mine = listed.body.data.find((i: { id: string }) => i.id === invitation.id);
    expect(mine).toMatchObject({ vehiclePlate: 'LEA1234', visitorPhone: '+923007654321' });
    expect(JSON.stringify(listed.body)).not.toContain(pass.token);
  });

  it('lets household members and staff register visitors too', async () => {
    await register(child);
    await register(admin, 'U3');
  });

  it('refuses residents of other units, guards and finance officers', async () => {
    await as(owner).post(invitationsUrl('U2')).send(visitor()).expect(404);
    await as(guard).post(invitationsUrl('U1')).send(visitor()).expect(403);
    await as(finance).post(invitationsUrl('U1')).send(visitor()).expect(403);
    await as(guardQ).post(invitationsUrl('U1')).send(visitor()).expect(404);
  });

  it('rejects windows that are too long, already over or too far ahead', async () => {
    await as(owner)
      .post(invitationsUrl('U1'))
      .send(visitor({ validUntil: hours(24 * 32) }))
      .expect(400);
    await as(owner)
      .post(invitationsUrl('U1'))
      .send(visitor({ validFrom: hours(-3), validUntil: hours(-1) }))
      .expect(422);
    await as(owner)
      .post(invitationsUrl('U1'))
      .send(visitor({ validFrom: hours(24 * 91), validUntil: hours(24 * 92) }))
      .expect(422);
  });
});

describe('at the gate', () => {
  it('shows a guard only what is needed, by QR token or typed code', async () => {
    const { pass } = await register(owner);
    const byToken = await validate({ token: pass.token, gate: 'Main gate' });
    expect(byToken).toMatchObject({
      valid: true,
      pass: {
        visitorName: 'Vera Visitor',
        vehiclePlate: 'LEA1234',
        unitNumber: 'U1',
        entriesLeft: 1,
      },
    });
    expect(JSON.stringify(byToken)).not.toMatch(/7654321|Resident|@example/);
    const byCode = await validate({ code: pass.code.toLowerCase().replace('-', ' ') });
    expect(byCode.valid).toBe(true);
    expect(await validate({ code: 'ZZZZ-ZZZZ' })).toEqual({ valid: false, reason: 'NOT_FOUND' });
  });

  it("does not accept a pass at another property's gate", async () => {
    const { pass } = await register(owner);
    expect(await validate({ token: pass.token }, guardQ, Q)).toEqual({
      valid: false,
      reason: 'NOT_FOUND',
    });
    await as(guardQ).post(gate('validate')).send({ token: pass.token }).expect(404);
  });

  it('admits once for a single-entry pass and then refuses', async () => {
    const { pass } = await register(owner);
    const { pass: view } = await validate({ token: pass.token });
    const visit = await as(guard)
      .post(gate('admit'))
      .send({ passId: view.passId, gate: 'Main gate' })
      .expect(201);
    expect(visit.body).toMatchObject({ decision: 'ADMITTED', unitNumber: 'U1', source: 'ONLINE' });
    const again = await as(guard).post(gate('admit')).send({ passId: view.passId }).expect(409);
    expect(again.body.error.code).toBe('PASS_NOT_VALID');
    expect(await validate({ token: pass.token })).toEqual({
      valid: false,
      reason: 'NO_ENTRIES_LEFT',
    });
  });

  it('lets only one of two gates use the last entry', async () => {
    const { pass } = await register(owner);
    const { pass: view } = await validate({ token: pass.token });
    const results = await Promise.all([
      as(guard).post(gate('admit')).send({ passId: view.passId, gate: 'North' }),
      as(supervisor).post(gate('admit')).send({ passId: view.passId, gate: 'South' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it('refuses revoked passes, passes not yet valid, and passes of a host who moved out', async () => {
    const revoked = await register(owner);
    await as(child)
      .post(`${invitationsUrl('U1')}/${revoked.invitation.id}/revoke`)
      .expect(200);
    expect(await validate({ token: revoked.pass.token })).toEqual({
      valid: false,
      reason: 'REVOKED',
    });

    const later = await register(owner, 'U1', { validFrom: hours(3), validUntil: hours(5) });
    expect(await validate({ token: later.pass.token })).toEqual({
      valid: false,
      reason: 'NOT_YET_VALID',
    });

    // The tenant's pass stops working the moment the tenancy is voided: stale access never wins.
    const tenants = await register(tenant, 'U2');
    expect((await validate({ token: tenants.pass.token })).valid).toBe(true);
    await as(admin)
      .post(`${uUrl('U2')}/tenancies/${tenancyId}/void`)
      .send({ reason: 'Entered by mistake' })
      .expect(200);
    expect(await validate({ token: tenants.pass.token })).toEqual({
      valid: false,
      reason: 'HOST_NO_LONGER_RESIDENT',
    });
  });

  it('records a refusal, for a pass or for someone without one', async () => {
    const { pass } = await register(owner);
    const { pass: view } = await validate({ token: pass.token });
    const denied = await as(guard)
      .post(gate('deny'))
      .send({ passId: view.passId, reason: 'Could not show ID' })
      .expect(201);
    expect(denied.body).toMatchObject({ decision: 'DENIED', denialReason: 'Could not show ID' });
    // A denial does not use up the entry.
    expect((await validate({ token: pass.token })).valid).toBe(true);
    await as(guard)
      .post(gate('deny'))
      .send({ category: 'DELIVERY', visitorName: 'Unknown courier', reason: 'No parcel booked' })
      .expect(201);
    await as(guard).post(gate('deny')).send({ reason: 'Nameless' }).expect(400);
  });

  it('needs the resident’s approval for walk-ins to a unit, records walk-ins to the property', async () => {
    const toUnit = await as(guard)
      .post(gate('walk-in'))
      .send({ unitId: units.U1, category: 'GUEST', visitorName: 'Surprise Guest' })
      .expect(409);
    expect(toUnit.body.error.code).toBe('WALK_IN_NEEDS_APPROVAL');

    const walkIn = await as(guard)
      .post(gate('walk-in'))
      .send({ category: 'DELIVERY', visitorName: 'Courier', vehiclePlate: 'kht 9' })
      .expect(201);
    const inside = await as(guard).get(`${pUrl()}/visits/inside`).expect(200);
    expect(inside.body.data.map((v: { id: string }) => v.id)).toContain(walkIn.body.id);

    const departed = await as(guard)
      .post(`${pUrl()}/visits/${walkIn.body.id}/depart`)
      .send({ gate: 'Main gate' })
      .expect(200);
    expect(departed.body.departedAt).not.toBeNull();
    const twice = await as(guard)
      .post(`${pUrl()}/visits/${walkIn.body.id}/depart`)
      .send({})
      .expect(409);
    expect(twice.body.error.code).toBe('VISIT_ALREADY_DEPARTED');
  });
});

describe('supervision', () => {
  it('gives supervisors the log and invitation list, not guards', async () => {
    const period = `from=${encodeURIComponent(hours(-24))}&to=${encodeURIComponent(hours(1))}`;
    const log = await as(supervisor).get(`${pUrl()}/visits?${period}`).expect(200);
    expect(log.body.data.length).toBeGreaterThan(0);
    await as(guard).get(`${pUrl()}/visits?${period}`).expect(403);
    await as(supervisor).get(`${pUrl()}/visitor-invitations`).expect(200);
    await as(guard).get(`${pUrl()}/visitor-invitations`).expect(403);
  });

  it('lets a supervisor revoke any invitation of the property', async () => {
    const { invitation, pass } = await register(owner);
    await as(guard).post(`${pUrl()}/visitor-invitations/${invitation.id}/revoke`).expect(403);
    const revoked = await as(supervisor)
      .post(`${pUrl()}/visitor-invitations/${invitation.id}/revoke`)
      .expect(200);
    expect(revoked.body.status).toBe('REVOKED');
    expect(await validate({ token: pass.token })).toEqual({ valid: false, reason: 'REVOKED' });
  });

  it('limits pass checks per guard so codes cannot be guessed', async () => {
    const busy = await signUp('busyguard');
    const invited = await as(admin)
      .post(`${orgUrl()}/invitations`)
      .send({ email: busy.email, role: 'SECURITY_GUARD', propertyId: P })
      .expect(201);
    await as(busy)
      .post('/api/v1/invitations/accept')
      .send({ token: invited.body.token })
      .expect(200);
    for (let i = 0; i < 60; i += 1) await validate({ code: 'ZZZZ-ZZZZ' }, busy);
    const limited = await as(busy).post(gate('validate')).send({ code: 'ZZZZ-ZZZZ' }).expect(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });
});

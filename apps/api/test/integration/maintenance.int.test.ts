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
import { OBJECT_STORAGE } from '../../src/platform/storage/object-storage';
import { FakeObjectStorage } from '../support/fake-object-storage';
import { InMemoryRateLimiter } from '../support/in-memory-rate-limiter';

/**
 * Maintenance over HTTP against the real database (Phase 7 Part 2): residents raise and follow
 * their unit's requests and see only resident-visible history; managers triage and run work
 * orders; technicians see and progress only their own work; costs are exact; roles, properties
 * and units are isolated.
 */

const PASSWORD = 'correct horse battery staple';
let app: INestApplication;
const storage = new FakeObjectStorage();
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

const NAMES = [
  'admin',
  'mgr',
  'tech',
  'tech2',
  'techq',
  'guard',
  'finance',
  'tenant',
  'child',
  'neighbour',
] as const;
const u = {} as Record<(typeof NAMES)[number], TestUser>;
let org: string;
let P: string;
let Q: string;
let gym: string;
const units: Record<string, string> = {};
const orgUrl = () => `/api/v1/organisations/${org}`;
const pUrl = (p = P) => `${orgUrl()}/properties/${p}`;
const mUrl = (path: string, p = P) => `${pUrl(p)}/maintenance/${path}`;
const myUrl = (path = '', p = P) => `${pUrl(p)}/my-work-orders${path ? `/${path}` : ''}`;
const unitUrl = (unit: string, path = '') =>
  `${pUrl()}/units/${units[unit]}/maintenance-requests${path ? `/${path}` : ''}`;

const report = {
  category: 'PLUMBING',
  title: 'Leaking kitchen tap',
  description: 'Drips all night',
  locationDetail: 'Kitchen',
};

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
    .overrideProvider(OBJECT_STORAGE)
    .useValue(storage)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, env);
  await app.init();

  const users = await Promise.all(NAMES.map(signUp));
  NAMES.forEach((name, i) => {
    u[name] = users[i] as TestUser;
  });
  org = (
    await as(u.admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Maintenance Org',
        slug: `maint-${run}`,
        countryCode: 'PK',
        defaultCurrency: 'PKR',
        defaultTimeZone: 'Asia/Karachi',
      })
      .expect(201)
  ).body.id;
  const property = async (code: string) =>
    (
      await as(u.admin)
        .post(`${orgUrl()}/properties`)
        .send({
          name: `Fixit ${code}`,
          code,
          type: 'CONDOMINIUM',
          addressLine1: '1 Road',
          city: 'Karachi',
        })
        .expect(201)
    ).body.id as string;
  P = await property('FP');
  Q = await property('FQ');
  for (const [user, role, propertyId] of [
    [u.mgr, 'MAINTENANCE_MANAGER', P],
    [u.tech, 'TECHNICIAN', P],
    [u.tech2, 'TECHNICIAN', P],
    [u.techq, 'TECHNICIAN', Q],
    [u.guard, 'SECURITY_GUARD', P],
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
  for (const number of ['U1', 'U2']) {
    units[number] = (
      await as(u.admin).post(`${pUrl()}/units`).send({ number, type: 'APARTMENT' }).expect(201)
    ).body.id;
  }
  gym = (
    await as(u.admin).post(`${pUrl()}/common-areas`).send({ name: 'Gym', type: 'GYM' }).expect(201)
  ).body.id;

  const resident = async (user: TestUser, fullName: string) => {
    const person = (
      await as(u.admin).post(`${pUrl()}/persons`).send({ fullName, email: user.email }).expect(201)
    ).body.id as string;
    return {
      person,
      link: async () => {
        const invited = await as(u.admin)
          .post(`${orgUrl()}/persons/${person}/invitations`)
          .expect(201);
        await as(user)
          .post('/api/v1/invitations/accept')
          .send({ token: invited.body.token })
          .expect(200);
      },
    };
  };
  const t = await resident(u.tenant, 'Tara Tenant');
  await as(u.admin)
    .post(`${pUrl()}/units/${units.U1}/tenancies`)
    .send({ startDate: '2026-01-01', occupants: [{ personId: t.person, isPrimary: true }] })
    .expect(201);
  const c = await resident(u.child, 'Kid Household');
  await as(u.admin)
    .post(`${pUrl()}/units/${units.U1}/household`)
    .send({ personId: c.person, relationship: 'CHILD', validFrom: '2026-01-01' })
    .expect(201);
  const n = await resident(u.neighbour, 'Ola Neighbour');
  await as(u.admin)
    .post(`${pUrl()}/units/${units.U2}/owners`)
    .send({
      effectiveFrom: '2026-01-01',
      owners: [{ personId: n.person, shareNumerator: 1, shareDenominator: 1 }],
    })
    .expect(200);
  for (const r of [t, c, n]) await r.link();
});

afterAll(async () => {
  await app?.close();
});

/** A request raised by the tenant, accepted by the manager. */
async function acceptedRequest(title = 'Leaking kitchen tap'): Promise<string> {
  const created = (
    await as(u.tenant)
      .post(unitUrl('U1'))
      .send({ ...report, title })
      .expect(201)
  ).body;
  await as(u.mgr)
    .post(mUrl(`requests/${created.request.id}/accept`))
    .send({})
    .expect(200);
  return created.request.id;
}

describe('residents', () => {
  it('raise a request for their unit and follow it; household members too', async () => {
    const created = await as(u.child).post(unitUrl('U1')).send(report).expect(201);
    expect(created.body.request).toMatchObject({
      status: 'SUBMITTED',
      priority: 'MEDIUM',
      unitNumber: 'U1',
      submittedBy: { userId: u.child.id },
    });
    expect(created.body.request.number).toMatch(/^MR-\d{6}$/);
    expect(created.body.events).toHaveLength(1);
    // Everyone living there sees the unit's requests.
    const list = (await as(u.tenant).get(unitUrl('U1')).expect(200)).body.data;
    expect(list.map((r: { id: string }) => r.id)).toContain(created.body.request.id);
  });

  it('never reach another unit, and staff without the permission get nothing', async () => {
    const id = (await as(u.tenant).post(unitUrl('U1')).send(report).expect(201)).body.request.id;
    await as(u.neighbour).get(unitUrl('U1')).expect(404);
    await as(u.neighbour).get(`${pUrl()}/units/${units.U2}/maintenance-requests/${id}`).expect(404);
    await as(u.tech).get(unitUrl('U1')).expect(403);
    await as(u.guard).get(unitUrl('U1')).expect(403);
  });

  it('see only resident-visible history, never internal notes, work orders or costs', async () => {
    const id = await acceptedRequest('Broken socket');
    await as(u.mgr)
      .post(mUrl(`requests/${id}/notes`))
      .send({ body: 'Tenant is difficult', visibility: 'INTERNAL' })
      .expect(201);
    await as(u.mgr)
      .post(mUrl(`requests/${id}/notes`))
      .send({ body: 'An electrician comes on Monday', visibility: 'RESIDENT' })
      .expect(201);
    const work = (
      await as(u.mgr)
        .post(mUrl('work-orders'))
        .send({ requestId: id, assignedToUserId: u.tech.id })
        .expect(201)
    ).body;
    await as(u.mgr)
      .post(mUrl(`work-orders/${work.workOrder.id}/costs`))
      .send({ kind: 'MATERIAL', description: 'Socket', amount: '450' })
      .expect(201);
    const seen = (await as(u.tenant).get(unitUrl('U1', id)).expect(200)).body;
    const bodies = seen.events.map((e: { body: string | null }) => e.body);
    expect(bodies).toContain('An electrician comes on Monday');
    expect(bodies).not.toContain('Tenant is difficult');
    expect(seen.events.every((e: { visibility: string }) => e.visibility === 'RESIDENT')).toBe(
      true,
    );
    expect(seen).not.toHaveProperty('workOrders');
    // Staff see everything.
    const full = (
      await as(u.mgr)
        .get(mUrl(`requests/${id}`))
        .expect(200)
    ).body;
    expect(full.events.map((e: { body: string | null }) => e.body)).toContain(
      'Tenant is difficult',
    );
    expect(full.workOrders).toHaveLength(1);
  });

  it('cancel only their own request, and only before work starts', async () => {
    const id = (await as(u.tenant).post(unitUrl('U1')).send(report).expect(201)).body.request.id;
    const notMine = await as(u.child)
      .post(unitUrl('U1', `${id}/cancel`))
      .send({ reason: 'Not needed' })
      .expect(403);
    expect(notMine.body.error.code).toBe('NOT_REQUESTER');
    await as(u.tenant)
      .post(unitUrl('U1', `${id}/cancel`))
      .send({ reason: '' })
      .expect(400);
    const done = await as(u.tenant)
      .post(unitUrl('U1', `${id}/cancel`))
      .send({ reason: 'Fixed it myself' })
      .expect(200);
    expect(done.body.request).toMatchObject({ status: 'CANCELLED', statusNote: 'Fixed it myself' });
    await as(u.tenant)
      .post(unitUrl('U1', `${id}/notes`))
      .send({ body: 'Hello?' })
      .expect(409);
  });
});

describe('the full journey', () => {
  it('raise, accept, assign, do the work, resolve, reopen, redo and confirm', async () => {
    const id = await acceptedRequest('Shower drain blocked');
    // A manager cannot give work to a guard or to another property's technician.
    for (const who of [u.guard, u.techq]) {
      const refused = await as(u.mgr)
        .post(mUrl('work-orders'))
        .send({ requestId: id, assignedToUserId: who.id })
        .expect(422);
      expect(refused.body.error.code).toBe('ASSIGNEE_NOT_ALLOWED');
    }
    const assignees = (await as(u.mgr).get(mUrl('assignees')).expect(200)).body.data;
    const names = assignees.map((a: { name: string }) => a.name);
    expect(names).toEqual(expect.arrayContaining(['tech', 'tech2', 'mgr', 'admin']));
    expect(names).not.toContain('techq');
    expect(names).not.toContain('guard');

    const created = (await as(u.mgr).post(mUrl('work-orders')).send({ requestId: id }).expect(201))
      .body;
    const wo = created.workOrder.id as string;
    expect(created.workOrder).toMatchObject({
      status: 'OPEN',
      title: 'Shower drain blocked',
      unitNumber: 'U1',
    });
    expect(created.workOrder.description).toContain('Where: Kitchen');
    await as(u.mgr)
      .post(mUrl(`work-orders/${wo}/assign`))
      .send({ userId: u.tech.id })
      .expect(200);

    // Only the assignee sees and progresses it.
    const mine = (await as(u.tech).get(myUrl()).expect(200)).body.data;
    expect(mine.map((w: { id: string }) => w.id)).toContain(wo);
    expect((await as(u.tech2).get(myUrl()).expect(200)).body.data).toEqual([]);
    await as(u.tech2).get(myUrl(wo)).expect(404);
    await as(u.tech2)
      .post(myUrl(`${wo}/start`))
      .expect(404);
    await as(u.tech)
      .get(mUrl(`work-orders/${wo}`))
      .expect(403);
    await as(u.tech).get(mUrl('requests')).expect(403);

    await as(u.tech)
      .post(myUrl(`${wo}/complete`))
      .send({ note: 'Done' })
      .expect(409);
    await as(u.tech)
      .post(myUrl(`${wo}/start`))
      .expect(200);
    await as(u.tech)
      .post(myUrl(`${wo}/hold`))
      .send({ reason: 'Need a part' })
      .expect(200);
    await as(u.tech)
      .post(myUrl(`${wo}/start`))
      .expect(200);
    await as(u.tech)
      .post(myUrl(`${wo}/costs`))
      .send({ kind: 'LABOUR', description: '2 hours', amount: '2000.50' })
      .expect(201);
    await as(u.tech)
      .post(myUrl(`${wo}/notes`))
      .send({ body: 'Cleared the drain', visibility: 'RESIDENT' })
      .expect(201);
    // Resolving before the work is completed is refused.
    await as(u.mgr)
      .post(mUrl(`requests/${id}/resolve`))
      .send({})
      .expect(409);
    const completed = (
      await as(u.tech)
        .post(myUrl(`${wo}/complete`))
        .send({ note: 'Drain cleared' })
        .expect(200)
    ).body;
    expect(completed.workOrder).toMatchObject({ status: 'COMPLETED', statusNote: 'Drain cleared' });
    expect(completed.totalCost).toEqual({ amountMinor: '200050', currency: 'PKR' });

    await as(u.mgr)
      .post(mUrl(`requests/${id}/resolve`))
      .send({ note: 'Please check and confirm' })
      .expect(200);
    // Staff cannot confirm or reopen on a resident's behalf.
    await as(u.admin)
      .post(unitUrl('U1', `${id}/confirm`))
      .expect(403);
    await as(u.child)
      .post(unitUrl('U1', `${id}/reopen`))
      .send({ reason: 'Still slow' })
      .expect(200);

    const redo = (
      await as(u.mgr)
        .post(mUrl('work-orders'))
        .send({ requestId: id, assignedToUserId: u.tech2.id, priority: 'HIGH' })
        .expect(201)
    ).body.workOrder.id;
    await as(u.tech2)
      .post(myUrl(`${redo}/start`))
      .expect(200);
    await as(u.tech2)
      .post(myUrl(`${redo}/complete`))
      .send({ note: 'Replaced the trap' })
      .expect(200);
    await as(u.mgr)
      .post(mUrl(`requests/${id}/resolve`))
      .send({})
      .expect(200);
    const closed = (
      await as(u.tenant)
        .post(unitUrl('U1', `${id}/confirm`))
        .expect(200)
    ).body;
    expect(closed.request).toMatchObject({ status: 'CLOSED', reopenCount: 1 });
    expect(
      closed.events
        .filter((e: { type: string }) => e.type === 'STATUS_CHANGED')
        .map((e: { to: string }) => e.to),
    ).toEqual(['SUBMITTED', 'ACCEPTED', 'RESOLVED', 'ACCEPTED', 'RESOLVED', 'CLOSED']);
    expect(closed.events.map((e: { body: string | null }) => e.body)).toEqual(
      expect.arrayContaining(['Cleared the drain', 'Please check and confirm', 'Still slow']),
    );
  });

  it('rejects with a reason the resident sees; final requests stay final', async () => {
    const id = (await as(u.tenant).post(unitUrl('U1')).send(report).expect(201)).body.request.id;
    await as(u.mgr)
      .post(mUrl(`requests/${id}/reject`))
      .send({})
      .expect(400);
    await as(u.mgr)
      .post(mUrl(`requests/${id}/reject`))
      .send({ reason: 'The tap is the owner’s responsibility' })
      .expect(200);
    const seen = (await as(u.tenant).get(unitUrl('U1', id)).expect(200)).body;
    expect(seen.request).toMatchObject({ status: 'REJECTED' });
    expect(seen.events.at(-1).body).toBe('The tap is the owner’s responsibility');
    const again = await as(u.mgr)
      .post(mUrl(`requests/${id}/accept`))
      .send({})
      .expect(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('staff', () => {
  it('raise work for a common area directly, reassign, unassign and cancel it', async () => {
    const created = (
      await as(u.mgr)
        .post(mUrl('work-orders'))
        .send({ commonAreaId: gym, title: 'Treadmill belt', category: 'APPLIANCE' })
        .expect(201)
    ).body.workOrder;
    expect(created).toMatchObject({ commonAreaName: 'Gym', requestId: null, status: 'OPEN' });
    // No requester to tell.
    await as(u.mgr)
      .post(mUrl(`work-orders/${created.id}/notes`))
      .send({ body: 'Hi', visibility: 'RESIDENT' })
      .expect(422);
    await as(u.mgr)
      .post(mUrl(`work-orders/${created.id}/assign`))
      .send({ userId: u.tech.id })
      .expect(200);
    await as(u.mgr)
      .post(mUrl(`work-orders/${created.id}/unassign`))
      .expect(200);
    const cancelled = (
      await as(u.mgr)
        .post(mUrl(`work-orders/${created.id}/cancel`))
        .send({ reason: 'Replaced under warranty' })
        .expect(200)
    ).body;
    expect(cancelled.workOrder.status).toBe('CANCELLED');
    await as(u.mgr)
      .post(mUrl(`work-orders/${created.id}/costs`))
      .send({ kind: 'OTHER', description: 'Call-out', amount: '100' })
      .expect(409);
  });

  it('report problems for a place, change priority, and void a wrong cost', async () => {
    const r = (
      await as(u.mgr)
        .post(mUrl('requests'))
        .send({ ...report, commonAreaId: gym, title: 'Mirror cracked', category: 'STRUCTURAL' })
        .expect(201)
    ).body;
    expect(r).toMatchObject({
      commonAreaName: 'Gym',
      unitId: null,
      submittedBy: { userId: u.mgr.id },
    });
    const changed = (
      await as(u.mgr)
        .patch(mUrl(`requests/${r.id}`))
        .send({ priority: 'URGENT' })
        .expect(200)
    ).body;
    expect(changed.priority).toBe('URGENT');
    await as(u.mgr)
      .post(mUrl(`requests/${r.id}/accept`))
      .send({})
      .expect(200);
    const wo = (await as(u.mgr).post(mUrl('work-orders')).send({ requestId: r.id }).expect(201))
      .body.workOrder.id;
    const withCost = (
      await as(u.mgr)
        .post(mUrl(`work-orders/${wo}/costs`))
        .send({ kind: 'MATERIAL', description: 'Mirror', amount: '1.234' })
        .expect(422)
    ).body;
    expect(withCost.error.code).toBe('INVALID_MONEY');
    const ok = (
      await as(u.mgr)
        .post(mUrl(`work-orders/${wo}/costs`))
        .send({ kind: 'MATERIAL', description: 'Mirror', amount: '9000' })
        .expect(201)
    ).body;
    const costId = ok.costs[0].id;
    const voided = (
      await as(u.mgr)
        .post(mUrl(`costs/${costId}/void`))
        .send({ reason: 'Wrong price' })
        .expect(200)
    ).body;
    expect(voided.totalCost.amountMinor).toBe('0');
    await as(u.mgr)
      .post(mUrl(`costs/${costId}/void`))
      .send({ reason: 'Again' })
      .expect(409);
  });

  it('read-only roles read; nobody reaches another property', async () => {
    await as(u.finance).get(mUrl('requests')).expect(200);
    await as(u.finance)
      .post(mUrl('requests'))
      .send({ ...report, unitId: units.U1 })
      .expect(403);
    await as(u.guard).get(mUrl('requests')).expect(403);
    await as(u.techq).get(myUrl('', P)).expect(404);
    await as(u.mgr).get(mUrl('requests', Q)).expect(404);
  });
});

describe('attachments', () => {
  const png = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...new Array(120).fill(1),
  ]);
  const photo = { fileName: 'leak.png', contentType: 'image/png', sizeBytes: png.length };

  /** Asks, uploads (as the browser) and completes; returns the attachment id. */
  async function attach(
    ask: () => request.Test,
    complete: (id: string) => request.Test,
    bytes: Uint8Array = png,
  ): Promise<string> {
    const asked = (await ask().expect(201)).body;
    storage.put(asked.upload.url, bytes);
    await complete(asked.attachmentId).expect(200);
    return asked.attachmentId;
  }

  it('residents add a checked photo to their request; it shows only once it is checked', async () => {
    const id = (await as(u.tenant).post(unitUrl('U1')).send(report).expect(201)).body.request.id;
    const asked = (
      await as(u.tenant)
        .post(unitUrl('U1', `${id}/attachments`))
        .send({ ...photo, visibility: 'INTERNAL', kind: 'AFTER' })
        .expect(201)
    ).body;
    expect(asked.upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/png' } });
    expect(asked.upload.url).toContain(`org/${org}/prop/${P}/maintenance/${asked.attachmentId}`);
    expect((await as(u.tenant).get(unitUrl('U1', id)).expect(200)).body.attachments).toEqual([]);

    const early = await as(u.tenant)
      .post(unitUrl('U1', `${id}/attachments/${asked.attachmentId}/complete`))
      .expect(409);
    expect(early.body.error.code).toBe('UPLOAD_MISSING');
    storage.put(asked.upload.url, png);
    const done = (
      await as(u.tenant)
        .post(unitUrl('U1', `${id}/attachments/${asked.attachmentId}/complete`))
        .expect(200)
    ).body;
    // Residents' files are always resident-visible, whatever they ask for.
    expect(done).toMatchObject({ fileName: 'leak.png', visibility: 'RESIDENT', kind: 'OTHER' });

    const seen = (await as(u.child).get(unitUrl('U1', id)).expect(200)).body.attachments;
    expect(seen.map((a: { id: string }) => a.id)).toEqual([asked.attachmentId]);
    const link = (
      await as(u.child)
        .get(unitUrl('U1', `${id}/attachments/${asked.attachmentId}/download`))
        .expect(200)
    ).body;
    expect(link.url).toContain('signature=download');
    // Another unit cannot reach it, even by its id.
    await as(u.neighbour)
      .get(
        `${pUrl()}/units/${units.U2}/maintenance-requests/${id}/attachments/${asked.attachmentId}/download`,
      )
      .expect(404);
    // Staff see it too.
    const staffView = (
      await as(u.mgr)
        .get(mUrl(`requests/${id}`))
        .expect(200)
    ).body;
    expect(staffView.attachments).toHaveLength(1);
  });

  it('refuses a file that is not what it claims, and deletes it', async () => {
    const id = (await as(u.tenant).post(unitUrl('U1')).send(report).expect(201)).body.request.id;
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>'.padEnd(128));
    for (const [declared, bytes] of [
      [photo, html],
      [photo, png.slice(0, 100)],
    ] as const) {
      const asked = (
        await as(u.tenant)
          .post(unitUrl('U1', `${id}/attachments`))
          .send(declared)
          .expect(201)
      ).body;
      const key = storage.put(asked.upload.url, bytes);
      const refused = await as(u.tenant)
        .post(unitUrl('U1', `${id}/attachments/${asked.attachmentId}/complete`))
        .expect(422);
      expect(refused.body.error.code).toBe('FILE_REJECTED');
      expect(storage.objects.has(key)).toBe(false);
      await as(u.tenant)
        .get(unitUrl('U1', `${id}/attachments/${asked.attachmentId}/download`))
        .expect(404);
    }
    for (const bad of [
      { ...photo, contentType: 'image/svg+xml' },
      { ...photo, sizeBytes: 10 * 1024 * 1024 + 1 },
      { ...photo, sizeBytes: 0 },
    ]) {
      await as(u.tenant)
        .post(unitUrl('U1', `${id}/attachments`))
        .send(bad)
        .expect(400);
    }
  });

  it('keeps internal files from residents; technicians add evidence to their own work only', async () => {
    const id = await acceptedRequest('Ceiling stain');
    const internal = await attach(
      () =>
        as(u.mgr)
          .post(mUrl(`requests/${id}/attachments`))
          .send({ ...photo, fileName: 'survey.png', visibility: 'INTERNAL' }),
      (a) => as(u.mgr).post(mUrl(`attachments/${a}/complete`)),
    );
    const wo = (
      await as(u.mgr)
        .post(mUrl('work-orders'))
        .send({ requestId: id, assignedToUserId: u.tech.id })
        .expect(201)
    ).body.workOrder.id;
    await as(u.tech2)
      .post(myUrl(`${wo}/attachments`))
      .send({ ...photo, kind: 'BEFORE' })
      .expect(404);
    const before = await attach(
      () =>
        as(u.tech)
          .post(myUrl(`${wo}/attachments`))
          .send({ ...photo, fileName: 'before.png', kind: 'BEFORE', visibility: 'RESIDENT' }),
      (a) => as(u.tech).post(myUrl(`${wo}/attachments/${a}/complete`)),
    );
    const work = (await as(u.tech).get(myUrl(wo)).expect(200)).body;
    expect(work.attachments).toEqual([
      expect.objectContaining({ id: before, kind: 'BEFORE', workOrderId: wo }),
    ]);
    await as(u.tech2)
      .get(myUrl(`${wo}/attachments/${before}/download`))
      .expect(404);

    const resident = (await as(u.tenant).get(unitUrl('U1', id)).expect(200)).body.attachments;
    expect(resident.map((a: { fileName: string }) => a.fileName)).toEqual(['before.png']);
    await as(u.tenant)
      .get(unitUrl('U1', `${id}/attachments/${internal}/download`))
      .expect(404);
    const staffFiles = (
      await as(u.mgr)
        .get(mUrl(`requests/${id}`))
        .expect(200)
    ).body.attachments;
    expect(staffFiles).toHaveLength(2);
    await as(u.finance)
      .get(mUrl(`attachments/${internal}/download`))
      .expect(200);
    await as(u.finance)
      .post(mUrl(`attachments/${internal}/remove`))
      .expect(403);
  });

  it('are removed by their uploader or a manager, and the file is deleted', async () => {
    const id = (await as(u.tenant).post(unitUrl('U1')).send(report).expect(201)).body.request.id;
    const mine = await attach(
      () =>
        as(u.tenant)
          .post(unitUrl('U1', `${id}/attachments`))
          .send(photo),
      (a) => as(u.tenant).post(unitUrl('U1', `${id}/attachments/${a}/complete`)),
    );
    const notMine = await as(u.child)
      .post(unitUrl('U1', `${id}/attachments/${mine}/remove`))
      .expect(403);
    expect(notMine.body.error.code).toBe('NOT_UPLOADER');
    const before = storage.objects.size;
    await as(u.tenant)
      .post(unitUrl('U1', `${id}/attachments/${mine}/remove`))
      .expect(204);
    expect(storage.objects.size).toBe(before - 1);
    expect((await as(u.tenant).get(unitUrl('U1', id)).expect(200)).body.attachments).toEqual([]);
    await as(u.tenant)
      .post(unitUrl('U1', `${id}/attachments/${mine}/remove`))
      .expect(404);

    const other = await attach(
      () =>
        as(u.child)
          .post(unitUrl('U1', `${id}/attachments`))
          .send(photo),
      (a) => as(u.child).post(unitUrl('U1', `${id}/attachments/${a}/complete`)),
    );
    await as(u.mgr)
      .post(mUrl(`attachments/${other}/remove`))
      .expect(204);
  });

  it('allow at most 10 files per request, and none on a finished one', async () => {
    const id = (await as(u.tenant).post(unitUrl('U1')).send(report).expect(201)).body.request.id;
    for (let i = 0; i < 10; i++) {
      await as(u.tenant)
        .post(unitUrl('U1', `${id}/attachments`))
        .send(photo)
        .expect(201);
    }
    const full = await as(u.tenant)
      .post(unitUrl('U1', `${id}/attachments`))
      .send(photo)
      .expect(409);
    expect(full.body.error.code).toBe('ATTACHMENT_NOT_ALLOWED');
    const done = (await as(u.tenant).post(unitUrl('U1')).send(report).expect(201)).body.request.id;
    await as(u.tenant)
      .post(unitUrl('U1', `${done}/cancel`))
      .send({ reason: 'Never mind' })
      .expect(200);
    await as(u.tenant)
      .post(unitUrl('U1', `${done}/attachments`))
      .send(photo)
      .expect(409);
  });
});

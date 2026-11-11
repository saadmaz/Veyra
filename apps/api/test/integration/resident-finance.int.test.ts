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
 * Residents' finance over HTTP against the real database (Phase 6 Part 6): owners see only the
 * owners' account and tenants only their tenancy's; household members, other units' residents
 * and staff see nothing; drafts stay invisible; bank transfers are submitted idempotently and
 * confirmed (a payment, applied oldest first) or rejected by finance, never by the submitter.
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
});

let admin: TestUser;
let finance: TestUser;
let checker: TestUser; // a second finance officer who also owns U3
let manager: TestUser;
let owner: TestUser; // owns U1
let tenant: TestUser; // rents U1
let child: TestUser; // household member of U1
let neighbour: TestUser; // owns U2
let org: string;
let P: string;
const units: Record<string, string> = {};
const orgUrl = () => `/api/v1/organisations/${org}`;
const pUrl = () => `${orgUrl()}/properties/${P}`;
const fUrl = (path: string) => `${pUrl()}/finance/${path}`;
const mine = (unit: string, path = '') =>
  `${pUrl()}/units/${units[unit]}/my-finance${path ? `/${path}` : ''}`;

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
function month(offset: number): string {
  const [y, m] = today().split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 7);
}

const submit = (
  user: TestUser,
  unit: string,
  body: Record<string, unknown>,
  key: string | null = randomUUID(),
) => {
  const req = as(user).post(mine(unit, 'bank-transfers'));
  return (key ? req.set('Idempotency-Key', key) : req).send({
    transferredOn: today(),
    reference: 'FT-0001',
    ...body,
  });
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
    .compile();
  app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  configureApp(app, env);
  await app.init();

  [admin, finance, checker, manager, owner, tenant, child, neighbour] = (await Promise.all(
    ['admin', 'finance', 'checker', 'manager', 'owner', 'tenant', 'child', 'neighbour'].map(signUp),
  )) as TestUser[] as [
    TestUser,
    TestUser,
    TestUser,
    TestUser,
    TestUser,
    TestUser,
    TestUser,
    TestUser,
  ];
  org = (
    await as(admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Resident Finance Org',
        slug: `resfin-${run}`,
        countryCode: 'PK',
        defaultCurrency: 'PKR',
        defaultTimeZone: 'Asia/Karachi',
      })
      .expect(201)
  ).body.id;
  P = (
    await as(admin)
      .post(`${orgUrl()}/properties`)
      .send({
        name: 'Ledger Heights',
        code: 'LH',
        type: 'CONDOMINIUM',
        addressLine1: '1 Road',
        city: 'Karachi',
      })
      .expect(201)
  ).body.id;
  for (const [user, role, propertyId] of [
    [finance, 'FINANCE_OFFICER', undefined],
    [checker, 'FINANCE_OFFICER', undefined],
    [manager, 'PROPERTY_MANAGER', P],
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

  /** A person linked to the user's login through an accepted resident invitation. */
  const resident = async (user: TestUser, fullName: string) => {
    const person = (
      await as(admin).post(`${pUrl()}/persons`).send({ fullName, email: user.email }).expect(201)
    ).body.id as string;
    return {
      person,
      link: async () => {
        const invited = await as(admin)
          .post(`${orgUrl()}/persons/${person}/invitations`)
          .expect(201);
        await as(user)
          .post('/api/v1/invitations/accept')
          .send({ token: invited.body.token })
          .expect(200);
      },
    };
  };
  const owners = async (unit: string, person: string) =>
    as(admin)
      .post(`${pUrl()}/units/${units[unit]}/owners`)
      .send({
        effectiveFrom: '2026-01-01',
        owners: [{ personId: person, shareNumerator: 1, shareDenominator: 1 }],
      })
      .expect(200);

  const o = await resident(owner, 'Olu Owner');
  await owners('U1', o.person);
  const t = await resident(tenant, 'Tara Tenant');
  await as(admin)
    .post(`${pUrl()}/units/${units.U1}/tenancies`)
    .send({ startDate: '2026-01-01', occupants: [{ personId: t.person, isPrimary: true }] })
    .expect(201);
  const c = await resident(child, 'Kid Household');
  await as(admin)
    .post(`${pUrl()}/units/${units.U1}/household`)
    .send({ personId: c.person, relationship: 'CHILD', validFrom: '2026-01-01' })
    .expect(201);
  const n = await resident(neighbour, 'Ola Neighbour');
  await owners('U2', n.person);
  const k = await resident(checker, 'Chen Checker');
  await owners('U3', k.person);
  for (const r of [o, t, c, n, k]) await r.link();

  // Service 1,000 to owners and utilities 300 to the occupant, next month, issued at once.
  const setup = (await as(finance).post(fUrl('setup')).expect(200)).body;
  const type = (code: string) =>
    setup.chargeTypes.find((ct: { code: string }) => ct.code === code).id;
  for (const [code, amount] of [
    ['SERVICE', '1000'],
    ['UTILITIES', '300'],
  ] as const) {
    await as(finance)
      .post(fUrl('recurring-charges'))
      .send({ chargeTypeId: type(code), basis: 'FLAT', amount, startMonth: month(1) })
      .expect(201);
  }
  await as(finance)
    .post(fUrl('billing-runs'))
    .send({ month: month(1), dueDate: `${month(1)}-10`, issue: true })
    .expect(200);
  // A draft for U1's owners that residents must never see.
  await as(finance)
    .post(fUrl('invoices'))
    .send({
      unitId: units.U1,
      dueDate: `${month(1)}-20`,
      lines: [{ chargeTypeId: type('SERVICE'), amount: '50' }],
    })
    .expect(201);
});

afterAll(async () => {
  await app?.close();
});

describe('who sees what', () => {
  it('shows an owner the owners account and a tenant their tenancy account only', async () => {
    const o = (await as(owner).get(mine('U1')).expect(200)).body;
    expect(o).toMatchObject({ unitNumber: 'U1', currency: 'PKR', asOf: today() });
    expect(o.accounts).toEqual([
      {
        paidBy: 'OWNERS',
        tenancyId: null,
        balance: { amountMinor: '100000', currency: 'PKR' },
        overdue: { amountMinor: '0', currency: 'PKR' },
        pendingTransfers: { amountMinor: '0', currency: 'PKR' },
      },
    ]);
    const t = (await as(tenant).get(mine('U1')).expect(200)).body;
    expect(t.accounts).toHaveLength(1);
    expect(t.accounts[0]).toMatchObject({ paidBy: 'TENANTS', balance: { amountMinor: '30000' } });
  });

  it('lists only issued invoices of the caller account, never drafts or the other account', async () => {
    const o = (await as(owner).get(mine('U1', 'invoices')).expect(200)).body.data;
    expect(o.map((i: { billTo: string; status: string }) => [i.billTo, i.status])).toEqual([
      ['OWNERS', 'ISSUED'],
    ]);
    const t = (await as(tenant).get(mine('U1', 'invoices')).expect(200)).body.data;
    expect(t.map((i: { billTo: string }) => i.billTo)).toEqual(['TENANTS']);

    // The tenant's invoice does not exist for the owner, and the reverse.
    await as(owner)
      .get(mine('U1', `invoices/${t[0].id}`))
      .expect(404);
    await as(tenant)
      .get(mine('U1', `invoices/${o[0].id}`))
      .expect(404);
    const detail = (
      await as(owner)
        .get(mine('U1', `invoices/${o[0].id}`))
        .expect(200)
    ).body;
    expect(detail.lines).toHaveLength(1);
    expect(detail).not.toHaveProperty('journalEntryId');

    // A draft is finance's work in progress.
    const drafts = (
      await as(finance)
        .get(`${fUrl('invoices')}?unitId=${units.U1}&status=DRAFT`)
        .expect(200)
    ).body.data;
    expect(drafts).toHaveLength(1);
    await as(owner)
      .get(mine('U1', `invoices/${drafts[0].id}`))
      .expect(404);
  });

  it('refuses another account by name: 404, not a hint', async () => {
    await as(owner).get(mine('U1', 'invoices?paidBy=TENANTS')).expect(404);
    await as(owner).get(mine('U1', 'statement?paidBy=TENANTS')).expect(404);
    await as(tenant).get(mine('U1', 'statement?paidBy=OWNERS')).expect(404);
    await submit(tenant, 'U1', { paidBy: 'OWNERS', amount: '10' }).expect(404);
  });

  it('gives household members, neighbours and staff nothing', async () => {
    // Covered by the unit (household), but without the permission.
    await as(child).get(mine('U1')).expect(403);
    // Not covered at all: another unit's owner cannot tell U1 exists.
    await as(neighbour).get(mine('U1')).expect(404);
    // Staff use the property's finance routes; a manager holds no resident permission.
    await as(manager).get(mine('U1')).expect(403);
    // An admin holds the permission but has no account on the unit.
    await as(admin).get(mine('U1')).expect(404);
    await submit(admin, 'U1', { paidBy: 'OWNERS', amount: '10' }).expect(404);
  });

  it('gives the statement of the caller account', async () => {
    const s = (await as(tenant).get(mine('U1', 'statement?paidBy=TENANTS')).expect(200)).body;
    expect(s).toMatchObject({ paidBy: 'TENANTS', balance: { amountMinor: '30000' } });
    expect(s.lines.map((l: { kind: string }) => l.kind)).toEqual(['INVOICE']);
    await as(tenant).get(mine('U1', 'statement')).expect(400);
  });
});

describe('bank transfers', () => {
  it('needs an Idempotency-Key and refuses a future date', async () => {
    const missing = await submit(owner, 'U1', { paidBy: 'OWNERS', amount: '1000' }, null).expect(
      400,
    );
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const tomorrow = new Date(`${today()}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    await submit(owner, 'U1', {
      paidBy: 'OWNERS',
      amount: '1000',
      transferredOn: tomorrow.toISOString().slice(0, 10),
    }).expect(422);
  });

  it('is confirmed by finance as a payment that pays the owners invoice', async () => {
    const key = randomUUID();
    const first = await submit(owner, 'U1', { paidBy: 'OWNERS', amount: '1000' }, key).expect(201);
    expect(first.body).toMatchObject({
      status: 'PENDING',
      paidBy: 'OWNERS',
      amount: { amountMinor: '100000', currency: 'PKR' },
      submittedBy: { name: 'owner' },
      receiptNumber: null,
    });
    // A retry returns the same submission; the key with another amount is refused.
    const again = await submit(owner, 'U1', { paidBy: 'OWNERS', amount: '1000' }, key).expect(200);
    expect(again.body.id).toBe(first.body.id);
    const reused = await submit(owner, 'U1', { paidBy: 'OWNERS', amount: '999' }, key).expect(409);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const summary = (await as(owner).get(mine('U1')).expect(200)).body;
    expect(summary.accounts[0].pendingTransfers.amountMinor).toBe('100000');

    // Finance sees it waiting; a manager may read the list but not decide.
    const waiting = (
      await as(manager)
        .get(`${fUrl('bank-transfers')}?status=PENDING`)
        .expect(200)
    ).body.data;
    expect(waiting.map((w: { id: string }) => w.id)).toContain(first.body.id);
    await as(manager)
      .post(fUrl(`bank-transfers/${first.body.id}/confirm`))
      .send({})
      .expect(403);

    const confirmed = (
      await as(finance)
        .post(fUrl(`bank-transfers/${first.body.id}/confirm`))
        .send({})
        .expect(200)
    ).body;
    expect(confirmed).toMatchObject({ status: 'CONFIRMED' });
    expect(confirmed.receiptNumber).toMatch(/^RCT-/);
    const again2 = await as(checker)
      .post(fUrl(`bank-transfers/${first.body.id}/confirm`))
      .send({})
      .expect(409);
    expect(again2.body.error.code).toBe('ALREADY_DECIDED');

    // The resident sees the receipt, the paid invoice and a zero balance.
    const receipts = (await as(owner).get(mine('U1', 'payments')).expect(200)).body.data;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      method: 'BANK_TRANSFER',
      reference: 'FT-0001',
      allocated: { amountMinor: '100000' },
    });
    await as(owner)
      .get(mine('U1', `payments/${receipts[0].id}`))
      .expect(200);
    await as(tenant)
      .get(mine('U1', `payments/${receipts[0].id}`))
      .expect(404);
    const invoices = (await as(owner).get(mine('U1', 'invoices')).expect(200)).body.data;
    expect(invoices[0].outstanding.amountMinor).toBe('0');
    const statement = (await as(owner).get(mine('U1', 'statement?paidBy=OWNERS')).expect(200)).body;
    expect(statement.balance.amountMinor).toBe('0');
    expect(statement.lines.map((l: { kind: string }) => l.kind)).toEqual(['INVOICE', 'PAYMENT']);
  });

  it('is rejected with a reason the resident sees', async () => {
    const submitted = (
      await submit(tenant, 'U1', {
        paidBy: 'TENANTS',
        amount: '300',
        reference: 'IBFT 77',
        note: 'Paid from my office account',
      }).expect(201)
    ).body;
    await as(finance)
      .post(fUrl(`bank-transfers/${submitted.id}/reject`))
      .send({ reason: '  ' })
      .expect(400);
    await as(finance)
      .post(fUrl(`bank-transfers/${submitted.id}/reject`))
      .send({ reason: 'Not on our statement yet; please send the bank slip' })
      .expect(200);
    const mineList = (await as(tenant).get(mine('U1', 'bank-transfers')).expect(200)).body.data;
    expect(mineList[0]).toMatchObject({
      id: submitted.id,
      status: 'REJECTED',
      rejectionReason: 'Not on our statement yet; please send the bank slip',
      note: 'Paid from my office account',
    });
    // The owner never sees the tenant's submissions.
    const ownerList = (await as(owner).get(mine('U1', 'bank-transfers')).expect(200)).body.data;
    expect(ownerList.map((t: { paidBy: string }) => t.paidBy)).toEqual(['OWNERS']);
  });

  it('is never checked by the person who submitted it', async () => {
    const own = (await submit(checker, 'U3', { paidBy: 'OWNERS', amount: '1300' }).expect(201))
      .body;
    const self = await as(checker)
      .post(fUrl(`bank-transfers/${own.id}/confirm`))
      .send({})
      .expect(403);
    expect(self.body.error.code).toBe('SAME_PERSON');
    await as(checker)
      .post(fUrl(`bank-transfers/${own.id}/reject`))
      .send({ reason: 'Mine' })
      .expect(403);
    await as(finance)
      .post(fUrl(`bank-transfers/${own.id}/confirm`))
      .send({})
      .expect(200);
  });

  it('keeps at most 10 waiting per account', async () => {
    for (let i = 0; i < 10; i++) {
      await submit(neighbour, 'U2', { paidBy: 'OWNERS', amount: '1', reference: `R${i}` }).expect(
        201,
      );
    }
    const tooMany = await submit(neighbour, 'U2', { paidBy: 'OWNERS', amount: '1' }).expect(409);
    expect(tooMany.body.error.code).toBe('TOO_MANY_PENDING');
  });
});

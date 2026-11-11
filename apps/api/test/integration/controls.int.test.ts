import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { loadApiEnv } from '../../src/platform/config/env';
import { REDIS_CLIENT } from '../../src/platform/infrastructure/infrastructure.module';
import { RATE_LIMITER } from '../../src/platform/rate-limit/rate-limiter';
import { InMemoryRateLimiter } from '../support/in-memory-rate-limiter';

/**
 * Controls and reports over HTTP against the real database (Phase 6 Part 4): maker-checker
 * approvals (never the requester, never a manager), refunds, payment reversals, credit notes,
 * write-offs, closing and reopening periods, statements and ageing.
 */

const PASSWORD = 'correct horse battery staple';
let app: INestApplication;
let db: pg.Pool;
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
let manager: TestUser;
let checker: TestUser; // a second finance officer
let org: string;
let P: string;
const units: Record<string, string> = {};
const orgUrl = () => `/api/v1/organisations/${org}`;
const pUrl = () => `${orgUrl()}/properties/${P}`;
const fUrl = (path: string) => `${pUrl()}/finance/${path}`;

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
function month(offset: number): string {
  const [y, m] = today().split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 7);
}

interface Invoice {
  id: string;
  unitNumber: string;
  billTo: string;
  billingMonth: string;
  outstanding: { amountMinor: string };
  paid: { amountMinor: string };
}

async function invoices(query: string): Promise<Invoice[]> {
  return (
    await as(finance)
      .get(`${fUrl('invoices')}?${query}`)
      .expect(200)
  ).body.data;
}

async function invoice(unit: string, billTo: string, billingMonth: string): Promise<Invoice> {
  const found = (await invoices(`unitId=${units[unit]}&billingMonth=${billingMonth}`)).find(
    (i) => i.billTo === billTo,
  );
  if (!found) throw new Error(`No ${billTo} invoice for ${unit} ${billingMonth}`);
  return found;
}

const record = (body: Record<string, unknown>, key: string = randomUUID(), user = finance) =>
  as(user)
    .post(fUrl('payments'))
    .set('Idempotency-Key', key)
    .send({
      method: 'BANK_TRANSFER',
      receivedOn: today(),
      ...body,
    });

/** Net credit balance (credits minus debits, minor units) of the unit on UNIT_CREDIT. */
async function unitCredit(unit: string): Promise<string> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [org]);
    const { rows } = await client.query(
      `SELECT coalesce(sum(l.credit_minor) - sum(l.debit_minor), 0)::text AS net
         FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
        WHERE a.system_key = 'UNIT_CREDIT' AND l.unit_id = $1`,
      [units[unit]],
    );
    await client.query('COMMIT');
    return rows[0].net;
  } finally {
    client.release();
  }
}

/** Unused money of the party's payments on the unit (from the API). */
async function unitCreditFor(unit: string, paidBy: 'OWNERS' | 'TENANTS'): Promise<bigint> {
  const payments = (
    await as(finance)
      .get(`${fUrl('payments')}?unitId=${units[unit]}`)
      .expect(200)
  ).body.data as { paidBy: string; unallocated: { amountMinor: string } }[];
  return payments
    .filter((p) => p.paidBy === paidBy)
    .reduce((sum, p) => sum + BigInt(p.unallocated.amountMinor), 0n);
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
    .useValue(new InMemoryRateLimiter())
    .compile();
  app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  configureApp(app, env);
  await app.init();
  db = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 2 });

  [admin, finance, manager, checker] = (await Promise.all(
    ['admin', 'finance', 'manager', 'checker'].map(signUp),
  )) as [TestUser, TestUser, TestUser, TestUser];
  org = (
    await as(admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Controls Org',
        slug: `controls-${run}`,
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
        name: 'Controls Court',
        code: 'RC',
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
  for (const number of ['U1', 'U2']) {
    units[number] = (
      await as(admin).post(`${pUrl()}/units`).send({ number, type: 'APARTMENT' }).expect(201)
    ).body.id;
  }
  const person = async (fullName: string) =>
    (await as(admin).post(`${pUrl()}/persons`).send({ fullName }).expect(201)).body.id as string;
  for (const [unit, name] of [
    ['U1', 'Olu Owner'],
    ['U2', 'Ola Owner'],
  ] as const) {
    await as(admin)
      .post(`${pUrl()}/units/${units[unit]}/owners`)
      .send({
        effectiveFrom: '2026-01-01',
        owners: [{ personId: await person(name), shareNumerator: 1, shareDenominator: 1 }],
      })
      .expect(200);
  }
  await as(admin)
    .post(`${pUrl()}/units/${units.U2}/tenancies`)
    .send({
      startDate: '2026-01-01',
      occupants: [{ personId: await person('Tara Tenant'), isPrimary: true }],
    })
    .expect(201);

  // Service 1,000 to owners and utilities 300 to the occupant, every month, issued at once.
  const setup = (await as(finance).post(fUrl('setup')).expect(200)).body;
  const type = (code: string) =>
    setup.chargeTypes.find((c: { code: string }) => c.code === code).id;
  for (const [code, amount] of [
    ['SERVICE', '1000'],
    ['UTILITIES', '300'],
  ] as const) {
    await as(finance)
      .post(fUrl('recurring-charges'))
      .send({ chargeTypeId: type(code), basis: 'FLAT', amount, startMonth: month(1) })
      .expect(201);
  }
  for (const offset of [1, 2]) {
    await as(finance)
      .post(fUrl('billing-runs'))
      .send({ month: month(offset), dueDate: `${month(offset)}-10`, issue: true })
      .expect(200);
  }
});

afterAll(async () => {
  await db?.end();
  await app?.close();
});

const requestApproval = (body: Record<string, unknown>, user = finance) =>
  as(user)
    .post(fUrl('approvals'))
    .send({ reason: 'Requested in a test', ...body });

describe('maker-checker', () => {
  it('lets a second finance officer approve a refund, never the requester or a manager', async () => {
    const payment = (
      await record({ unitId: units.U1, paidBy: 'OWNERS', amount: '5000' }).expect(201)
    ).body;
    // 2,000 paid the two invoices of 1,000 (service only on U1 owners? U1 has no tenancy: 1,300 each).
    const unused = BigInt(payment.unallocated.amountMinor);
    expect(unused).toBe(240000n);
    await requestApproval({
      action: 'REFUND',
      paymentId: payment.id,
      amount: '2400.01',
      method: 'BANK_TRANSFER',
    }).expect(422);
    const request = (
      await requestApproval({
        action: 'REFUND',
        paymentId: payment.id,
        amount: '1000',
        method: 'BANK_TRANSFER',
      }).expect(201)
    ).body;
    expect(request).toMatchObject({ status: 'PENDING', amount: { amountMinor: '100000' } });

    const self = await as(finance)
      .post(fUrl(`approvals/${request.id}/approve`))
      .send({})
      .expect(403);
    expect(self.body.error.code).toBe('SAME_PERSON');
    await as(manager)
      .post(fUrl(`approvals/${request.id}/approve`))
      .send({})
      .expect(403);
    const done = await as(checker)
      .post(fUrl(`approvals/${request.id}/approve`))
      .send({ note: 'Checked the bank details' })
      .expect(200);
    expect(done.body).toMatchObject({
      status: 'APPROVED',
      decidedBy: { userId: checker.id },
      decisionNote: 'Checked the bank details',
    });
    await as(checker)
      .post(fUrl(`approvals/${request.id}/approve`))
      .send({})
      .expect(409);

    const after = (
      await as(finance)
        .get(fUrl(`payments/${payment.id}`))
        .expect(200)
    ).body;
    expect(after).toMatchObject({
      refunded: { amountMinor: '100000' },
      unallocated: { amountMinor: '140000' },
    });
    expect(await unitCredit('U1')).toBe('140000');
  });

  it('lets only the requester cancel, and someone else reject', async () => {
    const payment = (await record({ unitId: units.U2, paidBy: 'OWNERS', amount: '10' }).expect(201))
      .body;
    const first = (
      await requestApproval({ action: 'REVERSE_PAYMENT', paymentId: payment.id }).expect(201)
    ).body;
    await as(checker)
      .post(fUrl(`approvals/${first.id}/cancel`))
      .expect(403);
    expect(
      (
        await as(finance)
          .post(fUrl(`approvals/${first.id}/cancel`))
          .expect(200)
      ).body.status,
    ).toBe('CANCELLED');
    const second = (
      await requestApproval({ action: 'REVERSE_PAYMENT', paymentId: payment.id }).expect(201)
    ).body;
    await as(finance)
      .post(fUrl(`approvals/${second.id}/reject`))
      .send({})
      .expect(403);
    const rejected = await as(admin)
      .post(fUrl(`approvals/${second.id}/reject`))
      .send({ note: 'Cheque cleared after all' })
      .expect(200);
    expect(rejected.body.status).toBe('REJECTED');
    const listed = (
      await as(manager)
        .get(`${fUrl('approvals')}?status=REJECTED`)
        .expect(200)
    ).body.data as { id: string }[];
    expect(listed.map((a) => a.id)).toContain(second.id);
  });
});

describe('reversing a payment', () => {
  it('takes back its allocations and its ledger entry once approved', async () => {
    const before = await unitCredit('U2');
    const target = await invoice('U2', 'OWNERS', month(1));
    const payment = (
      await record({ unitId: units.U2, paidBy: 'OWNERS', amount: '1000', method: 'CHEQUE' }).expect(
        201,
      )
    ).body;
    expect((await invoice('U2', 'OWNERS', month(1))).outstanding.amountMinor).toBe(
      String(
        BigInt(target.outstanding.amountMinor) - 100000n > 0n
          ? BigInt(target.outstanding.amountMinor) - 100000n
          : 0n,
      ),
    );
    const request = (
      await requestApproval({
        action: 'REVERSE_PAYMENT',
        paymentId: payment.id,
        reason: 'Cheque bounced',
      }).expect(201)
    ).body;
    await as(checker)
      .post(fUrl(`approvals/${request.id}/approve`))
      .send({})
      .expect(200);
    const reversed = (
      await as(finance)
        .get(fUrl(`payments/${payment.id}`))
        .expect(200)
    ).body;
    expect(reversed.reversedOn).toBe(today());
    expect(
      reversed.allocations.every((a: { releasedAt: string | null }) => a.releasedAt !== null),
    ).toBe(true);
    expect((await invoice('U2', 'OWNERS', month(1))).outstanding).toEqual(target.outstanding);
    expect(await unitCredit('U2')).toBe(before);
    // Nothing more can be done with it.
    await requestApproval({ action: 'REVERSE_PAYMENT', paymentId: payment.id }).expect(409);
  });
});

describe('credit notes and write-offs', () => {
  it('corrects a line with a numbered credit note within what is still owed', async () => {
    const target = await invoice('U2', 'TENANTS', month(2));
    const url = fUrl(`invoices/${target.id}/credit-notes`);
    await as(finance).post(url).send({ lineNumber: 2, amount: '1', reason: 'x' }).expect(422);
    await as(finance).post(url).send({ lineNumber: 1, amount: '300.01', reason: 'x' }).expect(422);
    await as(manager).post(url).send({ lineNumber: 1, amount: '50', reason: 'x' }).expect(403);
    const res = await as(finance)
      .post(url)
      .send({ lineNumber: 1, amount: '50', reason: 'Meter read wrongly' })
      .expect(201);
    expect(res.body).toMatchObject({
      credited: { amountMinor: '5000' },
      outstanding: { amountMinor: '25000' },
      credits: [
        { kind: 'CREDIT_NOTE', number: 'CRN-000001', lineNumber: 1, reason: 'Meter read wrongly' },
      ],
    });
  });

  it('writes off what is owed only after a second person approves', async () => {
    const target = await invoice('U2', 'TENANTS', month(2));
    await requestApproval({ action: 'WRITE_OFF', invoiceId: target.id, amount: '250.01' }).expect(
      422,
    );
    const request = (
      await requestApproval({ action: 'WRITE_OFF', invoiceId: target.id, amount: '250' }).expect(
        201,
      )
    ).body;
    expect((await invoice('U2', 'TENANTS', month(2))).outstanding.amountMinor).toBe('25000');
    await as(admin)
      .post(fUrl(`approvals/${request.id}/approve`))
      .send({})
      .expect(200);
    const after = (
      await as(finance)
        .get(fUrl(`invoices/${target.id}`))
        .expect(200)
    ).body;
    expect(after).toMatchObject({
      outstanding: { amountMinor: '0' },
      credited: { amountMinor: '30000' },
    });
    expect(
      after.credits.map((c: { kind: string; number: string | null }) => [c.kind, c.number]),
    ).toEqual([
      ['CREDIT_NOTE', 'CRN-000001'],
      ['WRITE_OFF', null],
    ]);
  });
});

describe('accounting periods', () => {
  it('refuses postings into a closed period until a second person approves reopening it', async () => {
    const periods = (await as(finance).get(fUrl('periods')).expect(200)).body.data as {
      id: string;
      startDate: string;
      endDate: string;
      status: string;
    }[];
    const current = periods.find((p) => p.startDate <= today() && today() <= p.endDate);
    if (!current) throw new Error('No period for today');
    await as(manager)
      .post(fUrl(`periods/${current.id}/close`))
      .expect(403);
    expect(
      (
        await as(finance)
          .post(fUrl(`periods/${current.id}/close`))
          .expect(200)
      ).body.status,
    ).toBe('CLOSED');
    await as(finance)
      .post(fUrl(`periods/${current.id}/close`))
      .expect(409);
    const refused = await record({ unitId: units.U1, paidBy: 'OWNERS', amount: '1' }).expect(409);
    expect(refused.body.error.code).toBe('PERIOD_CLOSED');

    const request = (
      await requestApproval({
        action: 'REOPEN_PERIOD',
        periodId: current.id,
        reason: 'Late bank entries',
      }).expect(201)
    ).body;
    await as(checker)
      .post(fUrl(`approvals/${request.id}/approve`))
      .send({})
      .expect(200);
    await record({ unitId: units.U1, paidBy: 'OWNERS', amount: '1' }).expect(201);
    await requestApproval({ action: 'REOPEN_PERIOD', periodId: current.id }).expect(409);
  });
});

describe('statements and ageing', () => {
  it("lists a party's invoices, payments and credits with a running balance", async () => {
    await record({ unitId: units.U2, paidBy: 'TENANTS', amount: '100' }).expect(201);
    const s = (
      await as(manager)
        .get(`${fUrl(`units/${units.U2}/statement`)}?paidBy=TENANTS`)
        .expect(200)
    ).body;
    const kinds = s.lines.map((l: { kind: string }) => l.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['INVOICE', 'PAYMENT', 'CREDIT_NOTE', 'WRITE_OFF']),
    );
    const last = s.lines[s.lines.length - 1];
    expect(last.balance).toEqual(s.balance);
    // Owed minus credit held equals the sum of what is outstanding less unused payments.
    const outstanding = (await invoices(`unitId=${units.U2}`))
      .filter((i) => i.billTo === 'TENANTS')
      .reduce((sum, i) => sum + BigInt(i.outstanding.amountMinor), 0n);
    expect(BigInt(s.balance.amountMinor)).toBe(
      outstanding - (await unitCreditFor('U2', 'TENANTS')),
    );
    await as(finance)
      .get(`${fUrl(`units/${units.U1}/statement`)}?paidBy=TENANTS`)
      .expect(422);
  });

  it('ages what is owed by days past due', async () => {
    const now = (await as(finance).get(fUrl('ageing')).expect(200)).body;
    const later = (
      await as(finance)
        .get(`${fUrl('ageing')}?asOf=${month(6)}-01`)
        .expect(200)
    ).body;
    const total = (a: { totals: Record<string, { amountMinor: string }> }) =>
      Object.values(a.totals).reduce((sum, m) => sum + BigInt(m.amountMinor), 0n);
    expect(total(later)).toBe(total(now));
    expect(BigInt(now.totals.current.amountMinor)).toBe(total(now));
    expect(BigInt(later.totals.current.amountMinor)).toBe(0n);
    expect(
      BigInt(later.totals.days61to90.amountMinor) + BigInt(later.totals.over90.amountMinor),
    ).toBeGreaterThan(0n);
    const u2Owners = later.rows.find(
      (r: { unitNumber: string; billTo: string }) => r.unitNumber === 'U2' && r.billTo === 'OWNERS',
    );
    expect(u2Owners).toBeDefined();
  });
});

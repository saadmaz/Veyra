import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import {
  SANDBOX_SIGNATURE_HEADER,
  signSandboxPayload,
} from '../../src/modules/finance/infrastructure/sandbox-payment-gateway';
import { loadApiEnv } from '../../src/platform/config/env';
import { REDIS_CLIENT } from '../../src/platform/infrastructure/infrastructure.module';
import { RATE_LIMITER } from '../../src/platform/rate-limit/rate-limiter';
import { InMemoryRateLimiter } from '../support/in-memory-rate-limiter';

/**
 * Payments over HTTP against the real database (Phase 6 Part 3): recording with idempotency
 * keys, oldest-first allocation within the paying party, credit applied to later invoices,
 * releasing and reallocating, the ledger, permissions, and online payments through the sandbox
 * gateway (signatures, duplicate events, mismatched amounts, failures).
 */

const PASSWORD = 'correct horse battery staple';
const SECRET = 'test-sandbox-secret-0123456789abcdef';
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

function callback(
  event: Record<string, unknown>,
  options: { secret?: string; provider?: string } = {},
) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  return http()
    .post(`/api/v1/payment-callbacks/${options.provider ?? 'sandbox'}`)
    .set('Content-Type', 'application/json')
    .set(SANDBOX_SIGNATURE_HEADER, signSandboxPayload(options.secret ?? SECRET, body, t))
    .send(body);
}

const succeeded = (reference: string, amountMinor: string, id = `evt_${randomUUID()}`) => ({
  id,
  type: 'payment.succeeded',
  data: { reference, amountMinor, currency: 'PKR' },
});

beforeAll(async () => {
  const env = loadApiEnv({
    NODE_ENV: 'test',
    DATABASE_URL: inject('appDatabaseUrl'),
    REDIS_URL: 'redis://localhost:6379',
    API_CORS_ORIGINS: 'http://localhost:3000',
    PAYMENT_SANDBOX_SECRET: SECRET,
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

  [admin, finance, manager] = (await Promise.all(['admin', 'finance', 'manager'].map(signUp))) as [
    TestUser,
    TestUser,
    TestUser,
  ];
  org = (
    await as(admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Payments Org',
        slug: `payments-${run}`,
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
        name: 'Receipts Court',
        code: 'RC',
        type: 'CONDOMINIUM',
        addressLine1: '1 Road',
        city: 'Karachi',
      })
      .expect(201)
  ).body.id;
  for (const [user, role, propertyId] of [
    [finance, 'FINANCE_OFFICER', undefined],
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

describe('recording payments', () => {
  it('needs an Idempotency-Key and the manage permission', async () => {
    await as(finance)
      .post(fUrl('payments'))
      .send({
        unitId: units.U1,
        paidBy: 'OWNERS',
        method: 'CASH',
        amount: '10',
        receivedOn: today(),
      })
      .expect(400);
    await record(
      { unitId: units.U1, paidBy: 'OWNERS', amount: '10' },
      randomUUID(),
      manager,
    ).expect(403);
  });

  it('applies a payment to the oldest invoices first and returns it as a receipt', async () => {
    const key = randomUUID();
    const res = await record(
      { unitId: units.U1, paidBy: 'OWNERS', amount: '1500', reference: 'TT-1' },
      key,
    ).expect(201);
    expect(res.body).toMatchObject({
      receiptNumber: 'RCT-000001',
      method: 'BANK_TRANSFER',
      amount: { amountMinor: '150000', currency: 'PKR' },
      allocated: { amountMinor: '150000' },
      unallocated: { amountMinor: '0' },
      reference: 'TT-1',
    });
    expect((await invoice('U1', 'OWNERS', month(1))).outstanding.amountMinor).toBe('0');
    expect((await invoice('U1', 'OWNERS', month(2))).outstanding.amountMinor).toBe('110000');

    // The same key replays the same payment; a different request under it is refused.
    const replay = await record(
      { unitId: units.U1, paidBy: 'OWNERS', amount: '1500', reference: 'TT-1' },
      key,
    ).expect(200);
    expect(replay.body.id).toBe(res.body.id);
    await record({ unitId: units.U1, paidBy: 'OWNERS', amount: '1501' }, key).expect(409);
  });

  it('records a payment once when the same request arrives twice at the same time', async () => {
    const key = randomUUID();
    const body = { unitId: units.U1, paidBy: 'OWNERS', amount: '1', method: 'CASH' };
    const results = await Promise.all([record(body, key), record(body, key)]);
    expect(results.map((r) => r.status).sort()).toEqual(expect.arrayContaining([201]));
    const listed = (
      await as(finance)
        .get(`${fUrl('payments')}?unitId=${units.U1}`)
        .expect(200)
    ).body.data as { id: string; amount: { amountMinor: string } }[];
    expect(listed.filter((p) => p.amount.amountMinor === '100')).toHaveLength(1);
  });

  it("pays only the paying party's invoices and keeps the rest as credit", async () => {
    const res = await record({ unitId: units.U2, paidBy: 'TENANTS', amount: '1000' }).expect(201);
    // Two utility invoices of 300 each; 400 left over.
    expect(res.body.allocated.amountMinor).toBe('60000');
    expect(res.body.unallocated.amountMinor).toBe('40000');
    expect((await invoice('U2', 'TENANTS', month(1))).outstanding.amountMinor).toBe('0');
    expect((await invoice('U2', 'OWNERS', month(1))).outstanding.amountMinor).toBe('100000');
    expect(await unitCredit('U2')).toBe('40000');
  });

  it('applies existing credit when a new invoice is issued', async () => {
    await as(finance)
      .post(fUrl('billing-runs'))
      .send({ month: month(3), dueDate: `${month(3)}-10`, issue: true })
      .expect(200);
    expect((await invoice('U2', 'TENANTS', month(3))).outstanding.amountMinor).toBe('0');
    expect(await unitCredit('U2')).toBe('10000');
  });

  it('refuses future dates, a tenancy that does not exist and amounts with too many decimals', async () => {
    await record({
      unitId: units.U1,
      paidBy: 'OWNERS',
      amount: '10',
      receivedOn: '2999-01-01',
    }).expect(422);
    await record({ unitId: units.U1, paidBy: 'TENANTS', amount: '10' }).expect(422);
    await record({ unitId: units.U1, paidBy: 'OWNERS', amount: '10.001' }).expect(422);
  });
});

describe('reallocating', () => {
  it('releases an allocation once and lets it be allocated again', async () => {
    const payment = (
      await record({ unitId: units.U2, paidBy: 'OWNERS', amount: '1000' }).expect(201)
    ).body;
    const allocation = payment.allocations[0];
    const target = await invoice('U2', 'OWNERS', month(1));
    expect(allocation.invoiceId).toBe(target.id);

    const released = await as(finance)
      .post(fUrl(`allocations/${allocation.id}/release`))
      .expect(200);
    expect(released.body.unallocated.amountMinor).toBe('100000');
    expect((await invoice('U2', 'OWNERS', month(1))).outstanding.amountMinor).toBe('100000');
    await as(finance)
      .post(fUrl(`allocations/${allocation.id}/release`))
      .expect(409);

    // Allocate it to the next month's invoice instead.
    const next = await invoice('U2', 'OWNERS', month(2));
    await as(finance)
      .post(fUrl(`payments/${payment.id}/allocations`))
      .send({ invoiceId: next.id, amount: '1000.01' })
      .expect(422);
    const tenantsInvoice = await invoice('U2', 'TENANTS', month(2));
    await as(finance)
      .post(fUrl(`payments/${payment.id}/allocations`))
      .send({ invoiceId: tenantsInvoice.id, amount: '1' })
      .expect(422);
    const moved = await as(finance)
      .post(fUrl(`payments/${payment.id}/allocations`))
      .send({ invoiceId: next.id, amount: '1000' })
      .expect(200);
    expect(moved.body.unallocated.amountMinor).toBe('0');
    expect((await invoice('U2', 'OWNERS', month(2))).paid.amountMinor).toBe('100000');
  });

  it('shows payments to managers but not the means to change them', async () => {
    const any = (await as(manager).get(fUrl('payments')).expect(200)).body.data[0];
    await as(manager)
      .get(fUrl(`payments/${any.id}`))
      .expect(200);
    await as(manager)
      .post(fUrl(`allocations/${any.allocations[0].id}/release`))
      .expect(403);
  });
});

describe('online payments (sandbox gateway)', () => {
  async function startIntent(amount: string) {
    const res = await as(finance)
      .post(fUrl('payment-intents'))
      .send({ unitId: units.U1, paidBy: 'OWNERS', amount })
      .expect(201);
    expect(res.body.checkoutUrl).toMatch(/^https:\/\/sandbox\.payments\.invalid\/checkout\/sbx_/);
    const reference = res.body.checkoutUrl.split('/').pop() as string;
    return { id: res.body.intent.id as string, reference };
  }

  it('records the payment once from a correctly signed success', async () => {
    const intent = await startIntent('1100');
    await callback(succeeded(intent.reference, '110000'), { secret: 'x'.repeat(40) }).expect(401);
    const event = succeeded(intent.reference, '110000');
    const first = await callback(event).expect(200);
    expect(first.body).toEqual({ received: true, outcome: 'RECORDED' });
    expect((await callback(event).expect(200)).body.outcome).toBe('DUPLICATE');
    expect((await callback(succeeded(intent.reference, '110000')).expect(200)).body.outcome).toBe(
      'IGNORED_NOT_PENDING',
    );

    const status = (
      await as(finance)
        .get(fUrl(`payment-intents/${intent.id}`))
        .expect(200)
    ).body;
    expect(status).toMatchObject({ status: 'SUCCEEDED' });
    const payment = (
      await as(finance)
        .get(fUrl(`payments/${status.paymentId}`))
        .expect(200)
    ).body;
    expect(payment).toMatchObject({ method: 'GATEWAY', reference: intent.reference });
    expect((await invoice('U1', 'OWNERS', month(2))).outstanding.amountMinor).toBe('0');
  });

  it('leaves a mismatched amount pending and records failures', async () => {
    const mismatch = await startIntent('50');
    expect((await callback(succeeded(mismatch.reference, '4999')).expect(200)).body.outcome).toBe(
      'AMOUNT_MISMATCH',
    );
    expect(
      (
        await as(finance)
          .get(fUrl(`payment-intents/${mismatch.id}`))
          .expect(200)
      ).body.status,
    ).toBe('PENDING');

    const failing = await startIntent('50');
    const failed = await callback({
      id: `evt_${randomUUID()}`,
      type: 'payment.failed',
      data: { reference: failing.reference, amountMinor: '5000', currency: 'PKR' },
    }).expect(200);
    expect(failed.body.outcome).toBe('FAILED');
    expect(
      (
        await as(finance)
          .get(fUrl(`payment-intents/${failing.id}`))
          .expect(200)
      ).body,
    ).toMatchObject({ status: 'FAILED', paymentId: null });
  });

  it('answers unknown references and refuses unknown providers', async () => {
    expect((await callback(succeeded('sbx_unknownreference', '1')).expect(200)).body.outcome).toBe(
      'UNKNOWN_REFERENCE',
    );
    await callback(succeeded('sbx_unknownreference', '1'), { provider: 'acme' }).expect(404);
  });
});

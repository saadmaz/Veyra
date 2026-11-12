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
 * Billing over HTTP against the real database (Phase 6 Part 2): who may see and run finance,
 * set-up, charge types, recurring charges (flat, per sqm, property-wide and per unit), billing
 * runs (who pays, what cannot be billed, no double billing, concurrent runs), one-off invoices,
 * issuing to the ledger, discarding drafts and the period lock.
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
let finance: TestUser; // finance officer of the organisation
let financeQ: TestUser; // finance officer of property Q only
let manager: TestUser; // property manager of P
let guard: TestUser; // security guard of P
let owner: TestUser; // owner of U1
let org: string;
let P: string;
let Q: string;
const units: Record<string, string> = {};
const persons: Record<string, string> = {};
const orgUrl = () => `/api/v1/organisations/${org}`;
const pUrl = (property = P) => `${orgUrl()}/properties/${property}`;
const fUrl = (path: string, property = P) => `${pUrl(property)}/finance/${path}`;

const KARACHI = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' });
const today = () => KARACHI.format(new Date());
/** "YYYY-MM" of the month `offset` months after the current Karachi month. */
function month(offset: number): string {
  const [y, m] = today().split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  return d.toISOString().slice(0, 7);
}

let chargeTypes: Record<string, string> = {};

async function person(name: string, email?: string) {
  return (
    await as(admin)
      .post(`${pUrl()}/persons`)
      .send({ fullName: name, ...(email ? { email } : {}) })
      .expect(201)
  ).body.id as string;
}

async function invite(user: TestUser, role: string, propertyId?: string) {
  const invited = await as(admin)
    .post(`${orgUrl()}/invitations`)
    .send({ email: user.email, role, ...(propertyId ? { propertyId } : {}) })
    .expect(201);
  await as(user).post('/api/v1/invitations/accept').send({ token: invited.body.token }).expect(200);
}

/** Sum of debits minus credits per account system key for a journal entry (tenant context). */
async function ledger(entryId: string) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [org]);
    const { rows } = await client.query(
      `SELECT coalesce(a.system_key, a.code) AS account, l.unit_id,
              (sum(l.debit_minor) - sum(l.credit_minor))::text AS net, e.status::text AS status
         FROM journal_lines l
         JOIN ledger_accounts a ON a.id = l.account_id
         JOIN journal_entries e ON e.id = l.entry_id
        WHERE l.entry_id = $1
        GROUP BY 1, 2, 4 ORDER BY 1`,
      [entryId],
    );
    await client.query('COMMIT');
    return rows as { account: string; unit_id: string | null; net: string; status: string }[];
  } finally {
    client.release();
  }
}

/** Closes today's period, or reopens it through a request approved by a second person (Part 4). */
async function setPeriodStatus(status: 'OPEN' | 'CLOSED') {
  const periods = (await as(finance).get(fUrl('periods')).expect(200)).body.data as {
    id: string;
    startDate: string;
    endDate: string;
  }[];
  const current = periods.find((p) => p.startDate <= today() && today() <= p.endDate);
  if (!current) throw new Error('No accounting period for today');
  if (status === 'CLOSED') {
    await as(finance)
      .post(fUrl(`periods/${current.id}/close`))
      .expect(200);
    return;
  }
  const requested = await as(finance)
    .post(fUrl('approvals'))
    .send({ action: 'REOPEN_PERIOD', periodId: current.id, reason: 'Test reopening' })
    .expect(201);
  await as(admin)
    .post(fUrl(`approvals/${requested.body.id}/approve`))
    .send({})
    .expect(200);
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
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, env);
  await app.init();
  db = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 2 });

  [admin, finance, financeQ, manager, guard, owner] = (await Promise.all(
    ['admin', 'finance', 'financeq', 'manager', 'guard', 'owner'].map(signUp),
  )) as [TestUser, TestUser, TestUser, TestUser, TestUser, TestUser];
  org = (
    await as(admin)
      .post('/api/v1/organisations')
      .send({
        name: 'Finance Org',
        slug: `finance-${run}`,
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
          name: `Ledger Court ${code}`,
          code,
          type: 'CONDOMINIUM',
          addressLine1: '1 Road',
          city: 'Karachi',
        })
        .expect(201)
    ).body.id as string;
  P = await property('FP');
  Q = await property('FQ');
  await invite(finance, 'FINANCE_OFFICER');
  await invite(financeQ, 'FINANCE_OFFICER', Q);
  await invite(manager, 'PROPERTY_MANAGER', P);
  await invite(guard, 'SECURITY_GUARD', P);

  for (const [number, area] of [
    ['U1', '100.00'],
    ['U2', '80.50'],
    ['U3', undefined],
  ] as const) {
    units[number] = (
      await as(admin)
        .post(`${pUrl()}/units`)
        .send({ number, type: 'APARTMENT', ...(area ? { areaSqm: area } : {}) })
        .expect(201)
    ).body.id;
  }
  // Owners and the tenancy start well before any month billed here.
  persons.olu = await person('Olu Owner', owner.email);
  persons.ola = await person('Ola Owner');
  persons.tara = await person('Tara Tenant');
  for (const [unit, who] of [
    ['U1', 'olu'],
    ['U2', 'ola'],
  ] as const) {
    await as(admin)
      .post(`${pUrl()}/units/${units[unit]}/owners`)
      .send({
        effectiveFrom: '2026-01-01',
        owners: [{ personId: persons[who], shareNumerator: 1, shareDenominator: 1 }],
      })
      .expect(200);
  }
  await as(admin)
    .post(`${pUrl()}/units/${units.U2}/tenancies`)
    .send({ startDate: '2026-01-01', occupants: [{ personId: persons.tara, isPrimary: true }] })
    .expect(201);
  const invited = await as(admin)
    .post(`${orgUrl()}/persons/${persons.olu}/invitations`)
    .expect(201);
  await as(owner)
    .post('/api/v1/invitations/accept')
    .send({ token: invited.body.token })
    .expect(200);
});

afterAll(async () => {
  await db?.end();
  await app?.close();
});

describe('access', () => {
  it('lets finance officers set up a property, idempotently', async () => {
    const first = await as(finance).post(fUrl('setup')).expect(200);
    expect(first.body.accounts.map((a: { systemKey: string }) => a.systemKey)).toEqual([
      'BANK',
      'CASH',
      'GATEWAY_CLEARING',
      'RECEIVABLES',
      'UNIT_CREDIT',
      'DEPOSITS_HELD',
      'OPENING_BALANCE',
      'SERVICE_CHARGE_INCOME',
      'UTILITY_INCOME',
      'FACILITY_INCOME',
      'OTHER_INCOME',
      'BAD_DEBT',
    ]);
    const second = await as(finance).post(fUrl('setup')).expect(200);
    expect(second.body.accounts).toHaveLength(12);
    expect(second.body.chargeTypes.map((c: { code: string }) => c.code)).toEqual([
      'DEPOSIT',
      'FACILITY',
      'SERVICE',
      'UTILITIES',
    ]);
    chargeTypes = Object.fromEntries(
      second.body.chargeTypes.map((c: { code: string; id: string }) => [c.code, c.id]),
    );
  });

  it('lets property managers read but not run billing', async () => {
    await as(manager).get(fUrl('accounts')).expect(200);
    await as(manager).get(fUrl('invoices')).expect(200);
    await as(manager).post(fUrl('setup')).expect(403);
    await as(manager)
      .post(fUrl('billing-runs'))
      .send({ month: month(1), dueDate: `${month(1)}-10` })
      .expect(403);
  });

  it('keeps guards, residents and other properties out', async () => {
    await as(guard).get(fUrl('invoices')).expect(403);
    await as(owner).get(fUrl('invoices')).expect(404);
    await as(financeQ).get(fUrl('invoices')).expect(404);
    await as(financeQ).post(fUrl('setup', Q)).expect(200);
  });
});

describe('charge types and recurring charges', () => {
  it('refuses duplicate codes and non-income accounts', async () => {
    const accounts = (await as(finance).get(fUrl('accounts')).expect(200)).body.data as {
      id: string;
      systemKey: string;
    }[];
    const bank = accounts.find((a) => a.systemKey === 'BANK')?.id;
    const other = accounts.find((a) => a.systemKey === 'OTHER_INCOME')?.id;
    await as(finance)
      .post(fUrl('charge-types'))
      .send({ code: 'service', name: 'Again', liableParty: 'OWNERS', incomeAccountId: other })
      .expect(409);
    await as(finance)
      .post(fUrl('charge-types'))
      .send({ code: 'PARKING', name: 'Parking', liableParty: 'OCCUPANT', incomeAccountId: bank })
      .expect(422);
    const parking = await as(finance)
      .post(fUrl('charge-types'))
      .send({ code: 'parking', name: 'Parking', liableParty: 'OCCUPANT', incomeAccountId: other })
      .expect(201);
    expect(parking.body).toMatchObject({ code: 'PARKING', status: 'ACTIVE' });
    // Archived types are not billed.
    await as(finance)
      .post(fUrl(`charge-types/${parking.body.id}/archive`))
      .expect(200);
  });

  it('adds flat, per-sqm, property-wide and unit charges, refusing overlaps and bad amounts', async () => {
    const add = (body: Record<string, unknown>) =>
      as(finance).post(fUrl('recurring-charges')).send(body);
    const wide = await add({
      chargeTypeId: chargeTypes.SERVICE,
      basis: 'FLAT',
      amount: '5000',
      startMonth: month(1),
    }).expect(201);
    expect(wide.body).toMatchObject({
      unitId: null,
      amount: { amountMinor: '500000', currency: 'PKR' },
      startMonth: month(1),
      endMonth: null,
    });
    await add({
      unitId: units.U1,
      chargeTypeId: chargeTypes.SERVICE,
      basis: 'PER_SQM',
      amount: '12.50',
      startMonth: month(1),
    }).expect(201);
    await add({
      unitId: units.U3,
      chargeTypeId: chargeTypes.SERVICE,
      basis: 'PER_SQM',
      amount: '12.50',
      startMonth: month(1),
    }).expect(201);
    await add({
      chargeTypeId: chargeTypes.UTILITIES,
      basis: 'FLAT',
      amount: '1500',
      startMonth: month(1),
    }).expect(201);
    // Overlapping the property-wide service charge.
    await add({
      chargeTypeId: chargeTypes.SERVICE,
      basis: 'FLAT',
      amount: '1',
      startMonth: month(6),
    }).expect(409);
    await add({
      chargeTypeId: chargeTypes.UTILITIES,
      unitId: units.U2,
      basis: 'FLAT',
      amount: '1.234',
      startMonth: month(1),
    }).expect(422);
    const list = await as(manager).get(fUrl('recurring-charges')).expect(200);
    expect(list.body.data).toHaveLength(4);
  });

  it('ends a recurring charge earlier but never extends it', async () => {
    const created = await as(finance)
      .post(fUrl('recurring-charges'))
      .send({
        unitId: units.U2,
        chargeTypeId: chargeTypes.SERVICE,
        basis: 'FLAT',
        amount: '1',
        startMonth: month(20),
        endMonth: month(22),
      })
      .expect(201);
    const url = fUrl(`recurring-charges/${created.body.id}/end`);
    await as(finance)
      .post(url)
      .send({ endMonth: month(19) })
      .expect(422);
    await as(finance)
      .post(url)
      .send({ endMonth: month(23) })
      .expect(422);
    const ended = await as(finance)
      .post(url)
      .send({ endMonth: month(21) })
      .expect(200);
    expect(ended.body.endMonth).toBe(month(21));
  });
});

describe('billing runs', () => {
  let run1: {
    invoices: {
      id: string;
      unitNumber: string;
      billTo: string;
      status: string;
      total: { amountMinor: string };
      recipients: { fullName: string }[];
    }[];
    skipped: { unitNumber: string; chargeTypeCode: string; reason: string }[];
  };

  it('bills owners for service charges and tenants (or owners while vacant) for utilities', async () => {
    run1 = (
      await as(finance)
        .post(fUrl('billing-runs'))
        .send({ month: month(1), dueDate: `${month(1)}-10` })
        .expect(200)
    ).body;
    const summary = run1.invoices
      .map((i) => `${i.unitNumber} ${i.billTo} ${i.total.amountMinor} ${i.recipients[0]?.fullName}`)
      .sort();
    expect(summary).toEqual([
      // 12.50 x 100.00 sqm + 1,500 utilities (no tenancy: the owner pays).
      'U1 OWNERS 275000 Olu Owner',
      'U2 OWNERS 500000 Ola Owner',
      'U2 TENANTS 150000 Tara Tenant',
    ]);
    expect(run1.invoices.every((i) => i.status === 'DRAFT')).toBe(true);
    expect(
      run1.skipped.map((s) => `${s.unitNumber} ${s.chargeTypeCode} ${s.reason}`).sort(),
    ).toEqual(['U3 SERVICE NO_AREA', 'U3 UTILITIES NO_OWNER']);
  });

  it('never bills the same month twice', async () => {
    const again = await as(finance)
      .post(fUrl('billing-runs'))
      .send({ month: month(1), dueDate: `${month(1)}-10` })
      .expect(200);
    expect(again.body.invoices).toHaveLength(0);
  });

  it('bills again what was discarded, and nothing else', async () => {
    const u1 = run1.invoices.find((i) => i.unitNumber === 'U1');
    await as(finance)
      .post(fUrl(`invoices/${u1?.id}/discard`))
      .expect(204);
    await as(finance)
      .get(fUrl(`invoices/${u1?.id}`))
      .expect(404);
    const again = await as(finance)
      .post(fUrl('billing-runs'))
      .send({ month: month(1), dueDate: `${month(1)}-10` })
      .expect(200);
    expect(again.body.invoices.map((i: { unitNumber: string }) => i.unitNumber)).toEqual(['U1']);
    const listed = await as(manager)
      .get(`${fUrl('invoices')}?billingMonth=${month(1)}&status=DRAFT`)
      .expect(200);
    expect(listed.body.data).toHaveLength(3);
  });

  it('lets only one of two concurrent runs bill a month', async () => {
    const body = { month: month(2), dueDate: `${month(2)}-10` };
    const [a, b] = await Promise.all([
      as(finance).post(fUrl('billing-runs')).send(body),
      as(admin).post(fUrl('billing-runs')).send(body),
    ]);
    expect([a.status, b.status].every((s) => s === 200 || s === 409)).toBe(true);
    const listed = await as(finance)
      .get(`${fUrl('invoices')}?billingMonth=${month(2)}`)
      .expect(200);
    expect(listed.body.data).toHaveLength(3);
  });

  it('can issue the invoices it creates at once', async () => {
    const res = await as(finance)
      .post(fUrl('billing-runs'))
      .send({ month: month(3), dueDate: `${month(3)}-10`, issue: true })
      .expect(200);
    expect(res.body.invoices).toHaveLength(3);
    for (const invoice of res.body.invoices) {
      expect(invoice).toMatchObject({ status: 'ISSUED', issueDate: today() });
      expect(invoice.number).toMatch(/^INV-\d{6}$/);
    }
  });
});

describe('invoices', () => {
  it('issues a draft: numbered, posted to receivables and income, then frozen', async () => {
    const draft = (
      await as(finance)
        .get(`${fUrl('invoices')}?billingMonth=${month(1)}&unitId=${units.U1}`)
        .expect(200)
    ).body.data[0];
    const issued = await as(finance)
      .post(fUrl(`invoices/${draft.id}/issue`))
      .send({})
      .expect(200);
    expect(issued.body).toMatchObject({ status: 'ISSUED', issueDate: today() });
    expect(issued.body.lines.map((l: { description: string }) => l.description)).toHaveLength(2);
    const lines = await ledger(issued.body.journalEntryId);
    expect(lines).toEqual([
      { account: 'RECEIVABLES', unit_id: units.U1, net: '275000', status: 'POSTED' },
      { account: 'SERVICE_CHARGE_INCOME', unit_id: null, net: '-125000', status: 'POSTED' },
      { account: 'UTILITY_INCOME', unit_id: null, net: '-150000', status: 'POSTED' },
    ]);
    await as(finance)
      .post(fUrl(`invoices/${draft.id}/issue`))
      .send({})
      .expect(409);
    await as(finance)
      .post(fUrl(`invoices/${draft.id}/discard`))
      .expect(409);
  });

  it('creates one-off invoices for the right party and refuses mixed parties or past due dates', async () => {
    const base = { unitId: units.U2, dueDate: `${month(1)}-15` };
    const res = await as(finance)
      .post(fUrl('invoices'))
      .send({ ...base, lines: [{ chargeTypeId: chargeTypes.UTILITIES, amount: '320.75' }] })
      .expect(201);
    expect(res.body).toMatchObject({
      billTo: 'TENANTS',
      billingMonth: null,
      total: { amountMinor: '32075' },
      recipients: [{ fullName: 'Tara Tenant', share: null }],
      lines: [{ description: 'Utilities' }],
    });
    await as(finance)
      .post(fUrl('invoices'))
      .send({
        ...base,
        lines: [
          { chargeTypeId: chargeTypes.UTILITIES, amount: '10' },
          { chargeTypeId: chargeTypes.SERVICE, amount: '10' },
        ],
      })
      .expect(422);
    await as(finance)
      .post(fUrl('invoices'))
      .send({
        ...base,
        dueDate: '2020-01-01',
        lines: [{ chargeTypeId: chargeTypes.SERVICE, amount: '10' }],
      })
      .expect(422);
    await as(finance)
      .post(fUrl('invoices'))
      .send({
        ...base,
        unitId: units.U3,
        lines: [{ chargeTypeId: chargeTypes.SERVICE, amount: '10' }],
      })
      .expect(409);
  });

  it('refuses to issue into a closed period', async () => {
    const draft = (
      await as(finance)
        .get(`${fUrl('invoices')}?billingMonth=${month(2)}&status=DRAFT`)
        .expect(200)
    ).body.data[0];
    await setPeriodStatus('CLOSED');
    try {
      const res = await as(finance)
        .post(fUrl(`invoices/${draft.id}/issue`))
        .send({})
        .expect(409);
      expect(res.body.error.code).toBe('PERIOD_CLOSED');
    } finally {
      await setPeriodStatus('OPEN');
    }
    await as(finance)
      .post(fUrl(`invoices/${draft.id}/issue`))
      .send({})
      .expect(200);
  });

  it('shows managers invoices but not the means to issue them', async () => {
    const any = (await as(manager).get(fUrl('invoices')).expect(200)).body.data[0];
    await as(manager)
      .get(fUrl(`invoices/${any.id}`))
      .expect(200);
    await as(manager)
      .post(fUrl(`invoices/${any.id}/issue`))
      .send({})
      .expect(403);
  });
});

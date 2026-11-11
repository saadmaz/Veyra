import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Payments (migration 20261112150000_payments): a payment exists only with its posted ledger
 * entry and gets the next receipt number; payments never change; allocations stay within the
 * payment, the invoice, the unit and the paying party, also under concurrency; an allocation is
 * released once; intents complete once and only with their payment; provider events are unique
 * and append-only; a callback can find exactly its intent without tenant context.
 * Runs as veyra_app unless stated.
 */

let app: pg.Pool;
let superuser: pg.Pool;

async function inTenant<T>(
  organisationId: string,
  work: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.organisation_id', $1, true)", [organisationId]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const ids = {
  org: randomUUID(),
  prop: randomUUID(),
  unit1: randomUUID(),
  unit2: randomUUID(),
  owner: randomUUID(),
  tenancy2: randomUUID(),
  clerk: randomUUID(),
  bank: randomUUID(),
  receivables: randomUUID(),
  credit: randomUUID(),
  income: randomUUID(),
  service: randomUUID(),
};
const DATE = '2027-01-10';

/** Posts a two-line entry (debit first account, credit second) and returns its id. */
async function entry(
  c: pg.PoolClient,
  source: string,
  amount: number,
  debit: { account: string; unit?: string },
  credit: { account: string; unit?: string },
  date = DATE,
) {
  const id = randomUUID();
  await c.query(
    `INSERT INTO journal_entries (id, organisation_id, property_id, entry_date, description, source, currency, updated_at)
     VALUES ($1, $2, $3, $4, 'Test', $5, 'PKR', now())`,
    [id, ids.org, ids.prop, date, source],
  );
  for (const [n, side, debitMinor, creditMinor] of [
    [1, debit, amount, 0],
    [2, credit, 0, amount],
  ] as const) {
    await c.query(
      `INSERT INTO journal_lines (id, organisation_id, property_id, entry_id, line_number, account_id, unit_id,
         debit_minor, credit_minor, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PKR')`,
      [
        randomUUID(),
        ids.org,
        ids.prop,
        id,
        n,
        side.account,
        side.unit ?? null,
        debitMinor,
        creditMinor,
      ],
    );
  }
  await c.query(`UPDATE journal_entries SET status = 'POSTED' WHERE id = $1`, [id]);
  return id;
}

/** An issued invoice for the unit and party. */
async function issuedInvoice(
  c: pg.PoolClient,
  input: { unit?: string; total?: number; tenancy?: string | null; issue?: boolean } = {},
) {
  const id = randomUUID();
  const unit = input.unit ?? ids.unit1;
  const total = input.total ?? 500000;
  await c.query(
    `INSERT INTO invoices (id, organisation_id, property_id, unit_id, bill_to, tenancy_id, billing_date, due_date,
       currency, total_minor, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, '2027-01-01', '2027-01-20', 'PKR', $7, now())`,
    [
      id,
      ids.org,
      ids.prop,
      unit,
      input.tenancy ? 'TENANTS' : 'OWNERS',
      input.tenancy ?? null,
      total,
    ],
  );
  await c.query(
    `INSERT INTO invoice_lines (id, organisation_id, property_id, invoice_id, line_number, charge_type_id, description, amount_minor)
     VALUES ($1, $2, $3, $4, 1, $5, 'Service charge', $6)`,
    [randomUUID(), ids.org, ids.prop, id, ids.service, total],
  );
  await c.query(
    `INSERT INTO invoice_recipients (id, organisation_id, property_id, invoice_id, person_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), ids.org, ids.prop, id, ids.owner],
  );
  if (input.issue === false) return id;
  const posted = await entry(
    c,
    'INVOICE',
    total,
    { account: ids.receivables, unit },
    { account: ids.income },
  );
  await c.query(
    `UPDATE invoices SET status = 'ISSUED', journal_entry_id = $2, issue_date = $3 WHERE id = $1`,
    [id, posted, DATE],
  );
  return id;
}

interface PaymentInput {
  unit?: string;
  amount?: number;
  credited?: number;
  tenancy?: string | null;
  source?: string;
  date?: string;
  intent?: string;
}

async function payment(c: pg.PoolClient, input: PaymentInput = {}) {
  const id = randomUUID();
  const unit = input.unit ?? ids.unit1;
  const amount = input.amount ?? 300000;
  const posted = await entry(
    c,
    input.source ?? 'PAYMENT',
    input.credited ?? amount,
    { account: ids.bank },
    { account: ids.credit, unit },
    input.date ?? DATE,
  );
  const { rows } = await c.query(
    `INSERT INTO payments (id, organisation_id, property_id, unit_id, paid_by, tenancy_id, method, amount_minor,
       currency, received_on, journal_entry_id, payment_intent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PKR', $9, $10, $11) RETURNING receipt_number`,
    [
      id,
      ids.org,
      ids.prop,
      unit,
      input.tenancy ? 'TENANTS' : 'OWNERS',
      input.tenancy ?? null,
      input.intent ? 'GATEWAY' : 'BANK_TRANSFER',
      amount,
      DATE,
      posted,
      input.intent ?? null,
    ],
  );
  return { id, receipt: Number(rows[0].receipt_number) };
}

async function allocate(
  c: pg.PoolClient,
  paymentId: string,
  invoiceId: string,
  amount: number,
  unit = ids.unit1,
) {
  const id = randomUUID();
  const posted = await entry(
    c,
    'ALLOCATION',
    amount,
    { account: ids.credit, unit },
    { account: ids.receivables, unit },
  );
  await c.query(
    `INSERT INTO payment_allocations (id, organisation_id, property_id, unit_id, payment_id, invoice_id, amount_minor, journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, ids.org, ids.prop, unit, paymentId, invoiceId, amount, posted],
  );
  return id;
}

async function release(c: pg.PoolClient, allocationId: string, amount: number, unit = ids.unit1) {
  const posted = await entry(
    c,
    'ALLOCATION',
    amount,
    { account: ids.receivables, unit },
    { account: ids.credit, unit },
  );
  await c.query(
    `UPDATE payment_allocations SET released_at = now(), release_entry_id = $2 WHERE id = $1`,
    [allocationId, posted],
  );
}

const intent = (c: pg.PoolClient, reference: string, amount = 200000) => {
  const id = randomUUID();
  return c
    .query(
      `INSERT INTO payment_intents (id, organisation_id, property_id, unit_id, paid_by, amount_minor, currency,
         provider, provider_reference, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, 'OWNERS', $5, 'PKR', 'sandbox', $6, now() + interval '1 hour', now())`,
      [id, ids.org, ids.prop, ids.unit1, amount, reference],
    )
    .then(() => id);
};

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 4 });
  superuser = new pg.Pool({ connectionString: inject('superuserDatabaseUrl'), max: 1 });
  await app.query(
    `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, 'Payments Clerk', now())`,
    [ids.clerk, `payments-${ids.clerk}@example.test`],
  );
  await inTenant(ids.org, async (c) => {
    await c.query(
      `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
       VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
      [ids.org, `pay-${ids.org.slice(0, 8)}`],
    );
    await c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Payments Court', 'PY', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    );
    for (const [unit, number] of [
      [ids.unit1, 'P1'],
      [ids.unit2, 'P2'],
    ] as const) {
      await c.query(
        `INSERT INTO units (id, organisation_id, property_id, number, type, updated_at)
         VALUES ($1, $2, $3, $4, 'APARTMENT', now())`,
        [unit, ids.org, ids.prop, number],
      );
    }
    for (const [id, code, type, key] of [
      [ids.bank, '1000', 'ASSET', 'BANK'],
      [ids.receivables, '1100', 'ASSET', 'RECEIVABLES'],
      [ids.credit, '2100', 'LIABILITY', 'UNIT_CREDIT'],
      [ids.income, '4000', 'INCOME', null],
    ] as const) {
      await c.query(
        `INSERT INTO ledger_accounts (id, organisation_id, property_id, code, name, type, system_key, updated_at)
         VALUES ($1, $2, $3, $4, 'Account', $5, $6, now())`,
        [id, ids.org, ids.prop, code, type, key],
      );
    }
    await c.query(
      `INSERT INTO accounting_periods (id, organisation_id, property_id, start_date, end_date, updated_at)
       VALUES ($1, $2, $3, '2027-01-01', '2027-01-31', now())`,
      [randomUUID(), ids.org, ids.prop],
    );
    await c.query(
      `INSERT INTO charge_types (id, organisation_id, property_id, code, name, liable_party, income_account_id, updated_at)
       VALUES ($1, $2, $3, 'SERVICE', 'Service', 'OWNERS', $4, now())`,
      [ids.service, ids.org, ids.prop, ids.income],
    );
    await c.query(
      `INSERT INTO persons (id, organisation_id, full_name, updated_at) VALUES ($1, $2, 'Olu Owner', now())`,
      [ids.owner, ids.org],
    );
    await c.query(
      `INSERT INTO tenancies (id, organisation_id, property_id, unit_id, start_date, updated_at)
       VALUES ($1, $2, $3, $4, '2026-06-01', now())`,
      [ids.tenancy2, ids.org, ids.prop, ids.unit2],
    );
  });
});

afterAll(async () => {
  await app?.end();
  await superuser?.end();
});

describe('payments', () => {
  it.each(['payments', 'payment_allocations', 'payment_intents', 'payment_provider_events'])(
    'shows nothing in %s without tenant context',
    async (table) => {
      await inTenant(ids.org, (c) => payment(c));
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n).toBe(0);
    },
  );

  it('get consecutive receipt numbers per property', async () => {
    const [a, b] = await inTenant(ids.org, async (c) => [await payment(c), await payment(c)]);
    expect(b?.receipt).toBe((a?.receipt ?? 0) + 1);
  });

  it('exist only with a posted payment entry crediting the amount to unit credit', async () => {
    for (const input of [
      { credited: 299999 },
      { source: 'MANUAL' },
      { date: '2027-01-11' },
      { unit: ids.unit2, tenancy: ids.tenancy2, credited: 1 },
    ]) {
      await expect(inTenant(ids.org, (c) => payment(c, input))).rejects.toMatchObject({
        code: '23514',
      });
    }
  });

  it('never change, not even for the superuser', async () => {
    const { id } = await inTenant(ids.org, (c) => payment(c));
    await expect(
      inTenant(ids.org, (c) =>
        c.query('UPDATE payments SET reference = $2 WHERE id = $1', [id, 'x']),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      superuser.query('UPDATE payments SET amount_minor = 1 WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(superuser.query('DELETE FROM payments WHERE id = $1', [id])).rejects.toMatchObject(
      { code: '42501' },
    );
  });
});

describe('allocations', () => {
  it('stay within the payment and the invoice', async () => {
    await inTenant(ids.org, async (c) => {
      const invoice = await issuedInvoice(c, { total: 500000 });
      const pay = await payment(c, { amount: 300000 });
      await allocate(c, pay.id, invoice, 200000);
      await allocate(c, pay.id, invoice, 100000);
    });
    await expect(
      inTenant(ids.org, async (c) => {
        const invoice = await issuedInvoice(c);
        const pay = await payment(c, { amount: 300000 });
        await allocate(c, pay.id, invoice, 300001);
      }),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringMatching(/left of the payment/),
    });
    await expect(
      inTenant(ids.org, async (c) => {
        const invoice = await issuedInvoice(c, { total: 100000 });
        const pay = await payment(c, { amount: 300000 });
        await allocate(c, pay.id, invoice, 100001);
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/left to pay/) });
  });

  it("go only to issued invoices of the payment's unit and party", async () => {
    await expect(
      inTenant(ids.org, async (c) => {
        const draft = await issuedInvoice(c, { issue: false });
        const pay = await payment(c);
        await allocate(c, pay.id, draft, 1000);
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/issued/) });
    await expect(
      inTenant(ids.org, async (c) => {
        const other = await issuedInvoice(c, { unit: ids.unit2 });
        const pay = await payment(c);
        await allocate(c, pay.id, other, 1000);
      }),
    ).rejects.toMatchObject({ code: '23503' });
    // A tenant's payment never pays the owners' invoice of the same unit.
    await expect(
      inTenant(ids.org, async (c) => {
        const ownersInvoice = await issuedInvoice(c, { unit: ids.unit2 });
        const pay = await payment(c, { unit: ids.unit2, tenancy: ids.tenancy2 });
        await allocate(c, pay.id, ownersInvoice, 1000, ids.unit2);
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/whoever made it/) });
  });

  it('are released once, freeing the amount to allocate again', async () => {
    const first = await inTenant(ids.org, async (c) => {
      const invoice = await issuedInvoice(c, { total: 100000 });
      const pay = await payment(c, { amount: 100000 });
      const allocation = await allocate(c, pay.id, invoice, 100000);
      await release(c, allocation, 100000);
      await allocate(c, pay.id, invoice, 100000);
      return allocation;
    });
    await expect(inTenant(ids.org, (c) => release(c, first, 100000))).rejects.toMatchObject({
      code: '23514',
    });
    await expect(
      inTenant(ids.org, async (c) => {
        const invoice = await issuedInvoice(c);
        const pay = await payment(c);
        const id = await allocate(c, pay.id, invoice, 1000);
        await c.query('UPDATE payment_allocations SET amount_minor = 1 WHERE id = $1', [id]);
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('never overpay an invoice under concurrency', async () => {
    const { invoice, payA, payB } = await inTenant(ids.org, async (c) => ({
      invoice: await issuedInvoice(c, { total: 100000 }),
      payA: (await payment(c, { amount: 100000 })).id,
      payB: (await payment(c, { amount: 100000 })).id,
    }));
    const results = await Promise.allSettled([
      inTenant(ids.org, (c) => allocate(c, payA, invoice, 100000)),
      inTenant(ids.org, (c) => allocate(c, payB, invoice, 100000)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('payment intents and provider events', () => {
  it('start pending, succeed only with their payment, and complete once', async () => {
    const reference = `ref_${randomUUID()}`;
    await expect(
      inTenant(ids.org, async (c) => {
        const id = await intent(c, `ref_${randomUUID()}`);
        await c.query(
          `UPDATE payment_intents SET status = 'SUCCEEDED', completed_at = now() WHERE id = $1`,
          [id],
        );
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/payment recorded/) });
    await expect(
      inTenant(ids.org, async (c) => {
        const id = await intent(c, `ref_${randomUUID()}`, 200000);
        await payment(c, { intent: id, amount: 199999 });
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/matching pending/) });
    const id = await inTenant(ids.org, async (c) => {
      const created = await intent(c, reference, 200000);
      await payment(c, { intent: created, amount: 200000 });
      await c.query(
        `UPDATE payment_intents SET status = 'SUCCEEDED', completed_at = now() WHERE id = $1`,
        [created],
      );
      return created;
    });
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`UPDATE payment_intents SET status = 'FAILED' WHERE id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('let a callback see exactly its intent, and nothing else, without tenant context', async () => {
    const reference = `ref_${randomUUID()}`;
    const id = await inTenant(ids.org, async (c) => {
      await intent(c, `ref_${randomUUID()}`);
      return intent(c, reference);
    });
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.payment_reference', $1, true)", [
        `sandbox:${reference}`,
      ]);
      const intents = await client.query('SELECT id FROM payment_intents');
      expect(intents.rows.map((r) => r.id)).toEqual([id]);
      expect((await client.query('SELECT 1 FROM payments')).rowCount).toBe(0);
      await expect(
        client.query(
          `UPDATE payment_intents SET status = 'EXPIRED', completed_at = now() WHERE id = $1`,
          [id],
        ),
      ).resolves.toMatchObject({ rowCount: 0 });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('record each provider event once and never change it', async () => {
    const eventId = `evt_${randomUUID()}`;
    const insert = (c: pg.PoolClient, intentId: string) =>
      c.query(
        `INSERT INTO payment_provider_events (id, organisation_id, property_id, provider, provider_event_id, type, intent_id, outcome)
         VALUES ($1, $2, $3, 'sandbox', $4, 'payment.failed', $5, 'FAILED')`,
        [randomUUID(), ids.org, ids.prop, eventId, intentId],
      );
    const intentId = await inTenant(ids.org, async (c) => {
      const created = await intent(c, `ref_${randomUUID()}`);
      await insert(c, created);
      return created;
    });
    await expect(inTenant(ids.org, (c) => insert(c, intentId))).rejects.toMatchObject({
      code: '23505',
    });
    await expect(
      superuser.query(
        `UPDATE payment_provider_events SET outcome = 'X' WHERE provider_event_id = $1`,
        [eventId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

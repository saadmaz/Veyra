import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Controls (migration 20261112180000_controls): maker-checker approvals (a second person
 * decides, once, and an approval is carried out at once); write-offs, refunds and payment
 * reversals only with a matching approval used once; credit notes within the line and what the
 * invoice still owes; refunds within unused money; reversals only of unallocated payments, after
 * which nothing more is allocated; reopening a closed period only with an approval carried out
 * after it was closed. Runs as veyra_app unless stated.
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
  checker: randomUUID(),
  badDebt: randomUUID(),
  closedPeriod: randomUUID(),
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

interface ApprovalInput {
  action: 'REVERSE_PAYMENT' | 'REFUND' | 'WRITE_OFF' | 'REOPEN_PERIOD';
  payment?: string | null;
  invoice?: string | null;
  period?: string | null;
  amount?: number | null;
  method?: string | null;
}

const requestApproval = (c: pg.PoolClient, input: ApprovalInput) => {
  const id = randomUUID();
  return c
    .query(
      `INSERT INTO finance_approvals (id, organisation_id, property_id, action, payment_id, invoice_id, period_id,
         amount_minor, refund_method, reason, requested_by_user_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Test reason', $10, now())`,
      [
        id,
        ids.org,
        ids.prop,
        input.action,
        input.payment ?? null,
        input.invoice ?? null,
        input.period ?? null,
        input.amount ?? null,
        input.method ?? null,
        ids.clerk,
      ],
    )
    .then(() => id);
};

/** Approved by the checker and marked carried out now. */
const approve = (c: pg.PoolClient, id: string, by = ids.checker) =>
  c.query(
    `UPDATE finance_approvals SET status = 'APPROVED', decided_by_user_id = $2, decided_at = now(), executed_at = now()
      WHERE id = $1`,
    [id, by],
  );

const approved = async (c: pg.PoolClient, input: ApprovalInput) => {
  const id = await requestApproval(c, input);
  await approve(c, id);
  return id;
};

async function credit(
  c: pg.PoolClient,
  invoice: string,
  input: { kind?: 'CREDIT_NOTE' | 'WRITE_OFF'; amount: number; line?: number; approval?: string },
) {
  const kind = input.kind ?? 'CREDIT_NOTE';
  const posted = await entry(
    c,
    kind,
    input.amount,
    { account: kind === 'WRITE_OFF' ? ids.badDebt : ids.income },
    { account: ids.receivables, unit: ids.unit1 },
  );
  const { rows } = await c.query(
    `INSERT INTO invoice_credits (id, organisation_id, property_id, unit_id, invoice_id, kind, line_number, amount_minor,
       reason, credited_on, journal_entry_id, approval_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Correction', $9, $10, $11) RETURNING credit_number`,
    [
      randomUUID(),
      ids.org,
      ids.prop,
      ids.unit1,
      invoice,
      kind,
      kind === 'CREDIT_NOTE' ? (input.line ?? 1) : null,
      input.amount,
      DATE,
      posted,
      input.approval ?? null,
    ],
  );
  return rows[0].credit_number as string | null;
}

async function refund(
  c: pg.PoolClient,
  paymentId: string,
  input: { amount: number; approval: string; method?: string },
) {
  const posted = await entry(
    c,
    'REFUND',
    input.amount,
    { account: ids.credit, unit: ids.unit1 },
    { account: ids.bank },
  );
  await c.query(
    `INSERT INTO payment_refunds (id, organisation_id, property_id, unit_id, payment_id, amount_minor, method,
       refunded_on, journal_entry_id, approval_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      ids.org,
      ids.prop,
      ids.unit1,
      paymentId,
      input.amount,
      input.method ?? 'BANK_TRANSFER',
      DATE,
      posted,
      input.approval,
    ],
  );
}

/** Reverses the payment's own entry (mirror lines) and records the reversal. */
async function reverse(c: pg.PoolClient, paymentId: string, approval: string) {
  const { rows } = await c.query(
    'SELECT journal_entry_id, amount_minor::int AS amount FROM payments WHERE id = $1',
    [paymentId],
  );
  const original = rows[0] as { journal_entry_id: string; amount: number };
  const reversal = randomUUID();
  await c.query(
    `INSERT INTO journal_entries (id, organisation_id, property_id, entry_date, description, source, currency,
       reverses_entry_id, updated_at)
     VALUES ($1, $2, $3, $4, 'Reversal', 'REVERSAL', 'PKR', $5, now())`,
    [reversal, ids.org, ids.prop, DATE, original.journal_entry_id],
  );
  for (const [n, account, unit, debit, creditMinor] of [
    [1, ids.credit, ids.unit1, original.amount, 0],
    [2, ids.bank, null, 0, original.amount],
  ] as const) {
    await c.query(
      `INSERT INTO journal_lines (id, organisation_id, property_id, entry_id, line_number, account_id, unit_id,
         debit_minor, credit_minor, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PKR')`,
      [randomUUID(), ids.org, ids.prop, reversal, n, account, unit, debit, creditMinor],
    );
  }
  await c.query(`UPDATE journal_entries SET status = 'POSTED' WHERE id = $1`, [reversal]);
  await c.query(
    `INSERT INTO payment_reversals (id, organisation_id, property_id, payment_id, reversed_on, journal_entry_id, approval_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [randomUUID(), ids.org, ids.prop, paymentId, DATE, reversal, approval],
  );
}

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 4 });
  superuser = new pg.Pool({ connectionString: inject('superuserDatabaseUrl'), max: 1 });
  for (const [id, name] of [
    [ids.clerk, 'Controls Clerk'],
    [ids.checker, 'Controls Checker'],
  ] as const) {
    await app.query(
      `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, $3, now())`,
      [id, `controls-${id}@example.test`, name],
    );
  }
  await inTenant(ids.org, async (c) => {
    await c.query(
      `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
       VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
      [ids.org, `ctl-${ids.org.slice(0, 8)}`],
    );
    await c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Controls Court', 'CT', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    );
    for (const [unit, number] of [
      [ids.unit1, 'C1'],
      [ids.unit2, 'C2'],
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
      [ids.badDebt, '5100', 'EXPENSE', 'BAD_DEBT'],
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
      `INSERT INTO accounting_periods (id, organisation_id, property_id, start_date, end_date, status, closed_at, updated_at)
       VALUES ($1, $2, $3, '2026-12-01', '2026-12-31', 'CLOSED', now() - interval '1 day', now())`,
      [ids.closedPeriod, ids.org, ids.prop],
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

describe('tenant isolation', () => {
  it.each(['finance_approvals', 'invoice_credits', 'payment_refunds', 'payment_reversals'])(
    'shows nothing in %s without tenant context',
    async (table) => {
      await inTenant(ids.org, (c) =>
        requestApproval(c, { action: 'REOPEN_PERIOD', period: ids.closedPeriod }),
      );
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n).toBe(0);
    },
  );
});

describe('maker-checker', () => {
  it('refuses an approval or rejection by the requester, and a cancellation by anyone else', async () => {
    const id = await inTenant(ids.org, (c) =>
      requestApproval(c, { action: 'REOPEN_PERIOD', period: ids.closedPeriod }),
    );
    await expect(inTenant(ids.org, (c) => approve(c, id, ids.clerk))).rejects.toMatchObject({
      code: '23514',
    });
    for (const [status, by] of [
      ['REJECTED', ids.clerk],
      ['CANCELLED', ids.checker],
    ] as const) {
      await expect(
        inTenant(ids.org, (c) =>
          c.query(
            `UPDATE finance_approvals SET status = $2, decided_by_user_id = $3, decided_at = now() WHERE id = $1`,
            [id, status, by],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('carries out an approval at once, decides it once and never changes the request', async () => {
    const id = await inTenant(ids.org, (c) =>
      requestApproval(c, { action: 'REOPEN_PERIOD', period: ids.closedPeriod }),
    );
    await expect(
      inTenant(ids.org, (c) =>
        c.query(
          `UPDATE finance_approvals SET status = 'APPROVED', decided_by_user_id = $2, decided_at = now() WHERE id = $1`,
          [id, ids.checker],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await inTenant(ids.org, (c) =>
      c.query(
        `UPDATE finance_approvals SET status = 'REJECTED', decided_by_user_id = $2, decided_at = now() WHERE id = $1`,
        [id, ids.checker],
      ),
    );
    await expect(inTenant(ids.org, (c) => approve(c, id))).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('names exactly the target of its action', async () => {
    for (const input of [
      { action: 'REFUND', payment: ids.owner, amount: null, method: 'CASH' },
      { action: 'WRITE_OFF', amount: 10 },
      { action: 'REOPEN_PERIOD', period: ids.closedPeriod, amount: 10 },
      { action: 'REFUND', payment: ids.owner, amount: 10, method: 'GATEWAY' },
    ] as ApprovalInput[]) {
      await expect(inTenant(ids.org, (c) => requestApproval(c, input))).rejects.toMatchObject({
        code: '23514',
      });
    }
  });
});

describe('credit notes and write-offs', () => {
  it('number credit notes and keep them within the line and what is still owed', async () => {
    const numbers = await inTenant(ids.org, async (c) => {
      const invoice = await issuedInvoice(c, { total: 100000 });
      return [
        await credit(c, invoice, { amount: 30000 }),
        await credit(c, invoice, { amount: 20000 }),
      ];
    });
    expect(Number(numbers[1])).toBe(Number(numbers[0]) + 1);
    await expect(
      inTenant(ids.org, async (c) =>
        credit(c, await issuedInvoice(c, { total: 100000 }), { amount: 100001 }),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      inTenant(ids.org, async (c) => credit(c, await issuedInvoice(c), { amount: 1, line: 2 })),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/no line/) });
    // A paid invoice owes nothing: release the payment first.
    await expect(
      inTenant(ids.org, async (c) => {
        const invoice = await issuedInvoice(c, { total: 100000 });
        const pay = await payment(c, { amount: 100000 });
        await allocate(c, pay.id, invoice, 100000);
        await credit(c, invoice, { amount: 1 });
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/still owes/) });
    await expect(
      inTenant(ids.org, async (c) =>
        credit(c, await issuedInvoice(c, { issue: false }), { amount: 1 }),
      ),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/issued/) });
  });

  it('stop allocations from overpaying a credited invoice', async () => {
    await expect(
      inTenant(ids.org, async (c) => {
        const invoice = await issuedInvoice(c, { total: 100000 });
        await credit(c, invoice, { amount: 40000 });
        const pay = await payment(c, { amount: 100000 });
        await allocate(c, pay.id, invoice, 60001);
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/left to pay/) });
  });

  it('write off only with a matching approval, used once', async () => {
    await expect(
      inTenant(ids.org, async (c) =>
        credit(c, await issuedInvoice(c), { kind: 'WRITE_OFF', amount: 1000 }),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      inTenant(ids.org, async (c) => {
        const invoice = await issuedInvoice(c);
        const approval = await approved(c, { action: 'WRITE_OFF', invoice, amount: 1000 });
        await credit(c, invoice, { kind: 'WRITE_OFF', amount: 999, approval });
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/approval/) });
    await expect(
      inTenant(ids.org, async (c) => {
        const invoice = await issuedInvoice(c);
        const approval = await approved(c, { action: 'WRITE_OFF', invoice, amount: 1000 });
        await credit(c, invoice, { kind: 'WRITE_OFF', amount: 1000, approval });
        await credit(c, invoice, { kind: 'WRITE_OFF', amount: 1000, approval });
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('never change, not even for the superuser', async () => {
    await inTenant(ids.org, async (c) => credit(c, await issuedInvoice(c), { amount: 500 }));
    await expect(
      superuser.query('UPDATE invoice_credits SET amount_minor = 1'),
    ).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('refunds and reversals', () => {
  it('refund only unused money, by the approved method', async () => {
    await inTenant(ids.org, async (c) => {
      const invoice = await issuedInvoice(c, { total: 60000 });
      const pay = await payment(c, { amount: 100000 });
      await allocate(c, pay.id, invoice, 60000);
      const approval = await approved(c, {
        action: 'REFUND',
        payment: pay.id,
        amount: 40000,
        method: 'BANK_TRANSFER',
      });
      await refund(c, pay.id, { amount: 40000, approval });
    });
    await expect(
      inTenant(ids.org, async (c) => {
        const invoice = await issuedInvoice(c, { total: 60000 });
        const pay = await payment(c, { amount: 100000 });
        await allocate(c, pay.id, invoice, 60000);
        const approval = await approved(c, {
          action: 'REFUND',
          payment: pay.id,
          amount: 40001,
          method: 'BANK_TRANSFER',
        });
        await refund(c, pay.id, { amount: 40001, approval });
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/unused money/) });
    await expect(
      inTenant(ids.org, async (c) => {
        const pay = await payment(c, { amount: 1000 });
        const approval = await approved(c, {
          action: 'REFUND',
          payment: pay.id,
          amount: 1000,
          method: 'CASH',
        });
        await refund(c, pay.id, { amount: 1000, approval, method: 'BANK_TRANSFER' });
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/method/) });
  });

  it('stop a refunded amount from being allocated again', async () => {
    await expect(
      inTenant(ids.org, async (c) => {
        const pay = await payment(c, { amount: 1000 });
        const approval = await approved(c, {
          action: 'REFUND',
          payment: pay.id,
          amount: 600,
          method: 'CASH',
        });
        await refund(c, pay.id, { amount: 600, approval, method: 'CASH' });
        await allocate(c, pay.id, await issuedInvoice(c), 401);
      }),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringMatching(/left of the payment/),
    });
  });

  it('reverse a payment only when nothing of it is allocated, and then nothing more', async () => {
    await expect(
      inTenant(ids.org, async (c) => {
        const pay = await payment(c, { amount: 1000 });
        await allocate(c, pay.id, await issuedInvoice(c), 1000);
        await reverse(c, pay.id, await approved(c, { action: 'REVERSE_PAYMENT', payment: pay.id }));
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/release/) });
    await expect(
      inTenant(ids.org, async (c) => {
        const pay = await payment(c, { amount: 1000 });
        await reverse(c, pay.id, await approved(c, { action: 'REVERSE_PAYMENT', payment: pay.id }));
        await allocate(c, pay.id, await issuedInvoice(c), 1);
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/reversed/) });
    await expect(
      inTenant(ids.org, async (c) => {
        const pay = await payment(c, { amount: 1000 });
        await reverse(
          c,
          pay.id,
          await requestApproval(c, { action: 'REVERSE_PAYMENT', payment: pay.id }),
        );
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/approval/) });
    // Released allocations do not count.
    await inTenant(ids.org, async (c) => {
      const pay = await payment(c, { amount: 1000 });
      const allocation = await allocate(c, pay.id, await issuedInvoice(c), 1000);
      await release(c, allocation, 1000);
      await reverse(c, pay.id, await approved(c, { action: 'REVERSE_PAYMENT', payment: pay.id }));
    });
  });
});

describe('reopening a closed period', () => {
  it('needs an approval carried out after the period was closed', async () => {
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`UPDATE accounting_periods SET status = 'OPEN', closed_at = NULL WHERE id = $1`, [
          ids.closedPeriod,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await inTenant(ids.org, async (c) => {
      await approved(c, { action: 'REOPEN_PERIOD', period: ids.closedPeriod });
      await c.query(
        `UPDATE accounting_periods SET status = 'OPEN', closed_at = NULL WHERE id = $1`,
        [ids.closedPeriod],
      );
    });
    // Closed again later: the earlier approval no longer counts.
    await inTenant(ids.org, (c) =>
      c.query(
        `UPDATE accounting_periods SET status = 'CLOSED', closed_at = now() + interval '1 second' WHERE id = $1`,
        [ids.closedPeriod],
      ),
    );
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`UPDATE accounting_periods SET status = 'OPEN', closed_at = NULL WHERE id = $1`, [
          ids.closedPeriod,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

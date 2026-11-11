import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Billing (migration 20261112120000_billing): charge types book to income accounts, recurring
 * charges never overlap and only end, a recurring charge is never billed twice for a unit and
 * month, issuing requires a matching posted ledger entry and numbers invoices without gaps, and
 * issued invoices never change. Runs as veyra_app.
 */

let app: pg.Pool;

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
  orgB: randomUUID(),
  prop: randomUUID(),
  propB: randomUUID(),
  unit1: randomUUID(),
  unit2: randomUUID(),
  unitB: randomUUID(),
  owner: randomUUID(),
  tenant: randomUUID(),
  tenancy2: randomUUID(),
  clerk: randomUUID(),
  receivables: randomUUID(),
  income: randomUUID(),
  bank: randomUUID(),
  service: randomUUID(),
  utility: randomUUID(),
};

const JAN = '2027-01-01';

const recurring = (
  c: pg.PoolClient,
  input: { unit?: string | null; type?: string; start?: string; end?: string | null } = {},
) => {
  const id = randomUUID();
  return c
    .query(
      `INSERT INTO recurring_charges (id, organisation_id, property_id, unit_id, charge_type_id, basis, amount_minor,
         start_month, end_month, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'FLAT', 500000, $6, $7, now())`,
      [
        id,
        ids.org,
        ids.prop,
        input.unit === undefined ? ids.unit1 : input.unit,
        input.type ?? ids.service,
        input.start ?? JAN,
        input.end ?? null,
      ],
    )
    .then(() => id);
};

interface DraftInput {
  unit?: string;
  month?: string | null;
  total?: number;
  billTo?: 'OWNERS' | 'TENANTS';
  tenancy?: string | null;
}

const draftInvoice = (c: pg.PoolClient, input: DraftInput = {}) => {
  const id = randomUUID();
  return c
    .query(
      `INSERT INTO invoices (id, organisation_id, property_id, unit_id, bill_to, tenancy_id, billing_month,
         billing_date, due_date, currency, total_minor, created_by_user_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '2027-01-01', '2027-01-20', 'PKR', $8, $9, now())`,
      [
        id,
        ids.org,
        ids.prop,
        input.unit ?? ids.unit1,
        input.billTo ?? 'OWNERS',
        input.tenancy ?? null,
        input.month === undefined ? JAN : input.month,
        input.total ?? 500000,
        ids.clerk,
      ],
    )
    .then(() => id);
};

const addLine = (
  c: pg.PoolClient,
  invoice: string,
  input: {
    n?: number;
    amount?: number;
    recurringId?: string | null;
    unit?: string | null;
    month?: string | null;
    type?: string;
  } = {},
) =>
  c.query(
    `INSERT INTO invoice_lines (id, organisation_id, property_id, invoice_id, line_number, charge_type_id,
       description, amount_minor, recurring_charge_id, unit_id, billing_month)
     VALUES ($1, $2, $3, $4, $5, $6, 'Service charge', $7, $8, $9, $10)`,
    [
      randomUUID(),
      ids.org,
      ids.prop,
      invoice,
      input.n ?? 1,
      input.type ?? ids.service,
      input.amount ?? 500000,
      input.recurringId ?? null,
      input.recurringId ? (input.unit ?? ids.unit1) : null,
      input.recurringId ? (input.month ?? JAN) : null,
    ],
  );

const addRecipient = (c: pg.PoolClient, invoice: string, person = ids.owner) =>
  c.query(
    `INSERT INTO invoice_recipients (id, organisation_id, property_id, invoice_id, person_id, share_numerator, share_denominator)
     VALUES ($1, $2, $3, $4, $5, 1, 1)`,
    [randomUUID(), ids.org, ids.prop, invoice, person],
  );

/** A posted INVOICE entry: debit receivables for the unit, credit income. */
const postedEntry = async (
  c: pg.PoolClient,
  input: { amount?: number; unit?: string; date?: string; source?: string } = {},
) => {
  const entry = randomUUID();
  const amount = input.amount ?? 500000;
  await c.query(
    `INSERT INTO journal_entries (id, organisation_id, property_id, entry_date, description, source, currency, updated_at)
     VALUES ($1, $2, $3, $4, 'Invoice', $5, 'PKR', now())`,
    [entry, ids.org, ids.prop, input.date ?? '2027-01-10', input.source ?? 'INVOICE'],
  );
  await c.query(
    `INSERT INTO journal_lines (id, organisation_id, property_id, entry_id, line_number, account_id, unit_id, debit_minor, currency)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7, 'PKR')`,
    [randomUUID(), ids.org, ids.prop, entry, ids.receivables, input.unit ?? ids.unit1, amount],
  );
  await c.query(
    `INSERT INTO journal_lines (id, organisation_id, property_id, entry_id, line_number, account_id, credit_minor, currency)
     VALUES ($1, $2, $3, $4, 2, $5, $6, 'PKR')`,
    [randomUUID(), ids.org, ids.prop, entry, ids.income, amount],
  );
  await c.query(`UPDATE journal_entries SET status = 'POSTED' WHERE id = $1`, [entry]);
  return entry;
};

const issue = (c: pg.PoolClient, invoice: string, entry: string, date = '2027-01-10') =>
  c.query(
    `UPDATE invoices SET status = 'ISSUED', journal_entry_id = $2, issue_date = $3, issued_by_user_id = $4
      WHERE id = $1 RETURNING invoice_number, issued_at`,
    [invoice, entry, date, ids.clerk],
  );

/** A complete draft (line and recipient) ready to issue. */
const readyDraft = async (c: pg.PoolClient, input: DraftInput = {}) => {
  const invoice = await draftInvoice(c, input);
  await addLine(c, invoice, { amount: input.total ?? 500000 });
  await addRecipient(c, invoice);
  return invoice;
};

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 4 });
  await app.query(
    `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, 'Billing Clerk', now())`,
    [ids.clerk, `billing-${ids.clerk}@example.test`],
  );
  for (const [org, prop, code, units] of [
    [ids.org, ids.prop, 'BA', [ids.unit1, ids.unit2]],
    [ids.orgB, ids.propB, 'BB', [ids.unitB]],
  ] as const) {
    await inTenant(org, async (c) => {
      await c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `bill-${org.slice(0, 8)}`],
      );
      await c.query(
        `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
         VALUES ($1, $2, 'Billing Court', $3, 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
        [prop, org, code],
      );
      for (const [i, unit] of units.entries()) {
        await c.query(
          `INSERT INTO units (id, organisation_id, property_id, number, type, updated_at)
           VALUES ($1, $2, $3, $4, 'APARTMENT', now())`,
          [unit, org, prop, `B${i + 1}`],
        );
      }
    });
  }
  await inTenant(ids.org, async (c) => {
    for (const [id, code, type, key] of [
      [ids.receivables, '1100', 'ASSET', 'RECEIVABLES'],
      [ids.bank, '1000', 'ASSET', 'BANK'],
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
    for (const [id, code, party] of [
      [ids.service, 'SERVICE', 'OWNERS'],
      [ids.utility, 'UTILITIES', 'OCCUPANT'],
    ] as const) {
      await c.query(
        `INSERT INTO charge_types (id, organisation_id, property_id, code, name, liable_party, income_account_id, updated_at)
         VALUES ($1, $2, $3, $4, 'Charge', $5, $6, now())`,
        [id, ids.org, ids.prop, code, party, ids.income],
      );
    }
    for (const [id, name] of [
      [ids.owner, 'Olu Owner'],
      [ids.tenant, 'Tara Tenant'],
    ] as const) {
      await c.query(
        `INSERT INTO persons (id, organisation_id, full_name, updated_at) VALUES ($1, $2, $3, now())`,
        [id, ids.org, name],
      );
    }
    await c.query(
      `INSERT INTO tenancies (id, organisation_id, property_id, unit_id, start_date, updated_at)
       VALUES ($1, $2, $3, $4, '2026-06-01', now())`,
      [ids.tenancy2, ids.org, ids.prop, ids.unit2],
    );
  });
});

afterAll(async () => {
  await app?.end();
});

describe('tenant isolation', () => {
  it.each(['charge_types', 'recurring_charges', 'invoices', 'invoice_lines', 'invoice_recipients'])(
    'shows nothing in %s without tenant context',
    async (table) => {
      await inTenant(ids.org, (c) => readyDraft(c, { month: null }));
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n).toBe(0);
    },
  );

  it("refuses an invoice for another tenant's unit", async () => {
    await expect(
      inTenant(ids.org, (c) => draftInvoice(c, { unit: ids.unitB })),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('charge types and recurring charges', () => {
  it('book only to income accounts and keep their code', async () => {
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`UPDATE charge_types SET income_account_id = $2 WHERE id = $1`, [
          ids.service,
          ids.bank,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`UPDATE charge_types SET code = 'OTHER' WHERE id = $1`, [ids.service]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('cover whole months and never overlap for the same unit and type', async () => {
    await expect(
      inTenant(ids.org, (c) => recurring(c, { unit: ids.unit2, start: '2027-01-15' })),
    ).rejects.toMatchObject({ code: '23514' });
    await inTenant(ids.org, (c) => recurring(c, { unit: ids.unit2, end: '2027-03-01' }));
    await expect(
      inTenant(ids.org, (c) => recurring(c, { unit: ids.unit2, start: '2027-03-01' })),
    ).rejects.toMatchObject({ code: '23P01' });
    // Another type, a property-wide charge and the following month are fine.
    await inTenant(ids.org, async (c) => {
      await recurring(c, { unit: ids.unit2, type: ids.utility });
      await recurring(c, { unit: null, start: '2027-02-01' });
      await recurring(c, { unit: ids.unit2, start: '2027-04-01' });
    });
    await expect(
      inTenant(ids.org, (c) => recurring(c, { unit: null, start: '2027-05-01' })),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('change only their end month', async () => {
    const id = await inTenant(ids.org, (c) =>
      recurring(c, { unit: ids.unit1, type: ids.utility, start: '2028-01-01' }),
    );
    await inTenant(ids.org, (c) =>
      c.query(`UPDATE recurring_charges SET end_month = '2028-06-01' WHERE id = $1`, [id]),
    );
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`UPDATE recurring_charges SET amount_minor = 1 WHERE id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('invoice lines', () => {
  let charge: string;
  beforeAll(async () => {
    charge = await inTenant(ids.org, (c) =>
      recurring(c, { unit: ids.unit1, start: '2026-01-01', end: '2026-12-01' }),
    );
  });

  it('never bill a recurring charge twice for the same unit and month', async () => {
    await inTenant(ids.org, async (c) => {
      const invoice = await draftInvoice(c, { month: '2026-05-01' });
      await addLine(c, invoice, { recurringId: charge, month: '2026-05-01' });
    });
    await expect(
      inTenant(ids.org, async (c) => {
        const invoice = await draftInvoice(c, { month: '2026-05-01' });
        await addLine(c, invoice, { recurringId: charge, month: '2026-05-01' });
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it("must match their invoice's unit and month and their charge's type", async () => {
    await expect(
      inTenant(ids.org, async (c) => {
        const invoice = await draftInvoice(c, { month: '2026-06-01' });
        await addLine(c, invoice, { recurringId: charge, month: '2026-07-01' });
      }),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      inTenant(ids.org, async (c) => {
        const invoice = await draftInvoice(c, { month: '2026-06-01' });
        await addLine(c, invoice, { recurringId: charge, month: '2026-06-01', type: ids.utility });
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      inTenant(ids.org, async (c) => {
        const invoice = await draftInvoice(c, { month: '2026-06-01' });
        await addLine(c, invoice, { amount: 0 });
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('issuing', () => {
  it('numbers issued invoices per property without gaps', async () => {
    const numbers = await inTenant(ids.org, async (c) => {
      const out: number[] = [];
      for (let i = 0; i < 2; i++) {
        const invoice = await readyDraft(c, { month: null });
        const result = await issue(c, invoice, await postedEntry(c));
        out.push(Number(result.rows[0].invoice_number));
        expect(result.rows[0].issued_at).toBeInstanceOf(Date);
      }
      return out;
    });
    expect(numbers[1]).toBe((numbers[0] ?? 0) + 1);
  });

  it('refuses an invoice whose lines do not add up or that bills nobody', async () => {
    await expect(
      inTenant(ids.org, async (c) => {
        const invoice = await draftInvoice(c, { month: null, total: 500000 });
        await addLine(c, invoice, { amount: 400000 });
        await addRecipient(c, invoice);
        await issue(c, invoice, await postedEntry(c));
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/add up/) });
    await expect(
      inTenant(ids.org, async (c) => {
        const invoice = await draftInvoice(c, { month: null });
        await addLine(c, invoice);
        await issue(c, invoice, await postedEntry(c));
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/not addressed/) });
  });

  it('refuses a ledger entry that does not match the invoice', async () => {
    const cases: Array<{
      entry: Parameters<typeof postedEntry>[1];
      issueDate?: string;
      pattern: RegExp;
    }> = [
      { entry: { amount: 400000 }, pattern: /receivables/ },
      { entry: { unit: ids.unit2 }, pattern: /receivables/ },
      { entry: { source: 'MANUAL' }, pattern: /posted invoice entry/ },
      { entry: { date: '2027-01-11' }, pattern: /posted invoice entry/ },
    ];
    for (const { entry, pattern } of cases) {
      await expect(
        inTenant(ids.org, async (c) => {
          const invoice = await readyDraft(c, { month: null });
          await issue(c, invoice, await postedEntry(c, entry));
        }),
      ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(pattern) });
    }
  });

  it('uses each ledger entry for one invoice only', async () => {
    await expect(
      inTenant(ids.org, async (c) => {
        const entry = await postedEntry(c);
        await issue(c, await readyDraft(c, { month: null }), entry);
        await issue(c, await readyDraft(c, { month: null }), entry);
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses invoices inserted as issued and tenancies of another unit', async () => {
    await expect(
      inTenant(ids.org, (c) =>
        c.query(
          `INSERT INTO invoices (id, organisation_id, property_id, unit_id, bill_to, billing_date, due_date, currency,
             status, updated_at)
           VALUES ($1, $2, $3, $4, 'OWNERS', '2027-01-01', '2027-01-20', 'PKR', 'ISSUED', now())`,
          [randomUUID(), ids.org, ids.prop, ids.unit1],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      inTenant(ids.org, (c) =>
        draftInvoice(c, { unit: ids.unit1, billTo: 'TENANTS', tenancy: ids.tenancy2 }),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await inTenant(ids.org, (c) =>
      draftInvoice(c, { unit: ids.unit2, billTo: 'TENANTS', tenancy: ids.tenancy2 }),
    );
  });
});

describe('issued invoices', () => {
  let issued: string;
  beforeAll(async () => {
    issued = await inTenant(ids.org, async (c) => {
      const invoice = await readyDraft(c, { month: null });
      await issue(c, invoice, await postedEntry(c));
      return invoice;
    });
  });

  it('never change: no edits, deletions, new lines or recipients', async () => {
    const attempts: Array<(c: pg.PoolClient) => Promise<unknown>> = [
      (c) => c.query(`UPDATE invoices SET due_date = '2027-02-28' WHERE id = $1`, [issued]),
      (c) => c.query(`DELETE FROM invoices WHERE id = $1`, [issued]),
      (c) => c.query(`DELETE FROM invoice_lines WHERE invoice_id = $1`, [issued]),
      (c) => c.query(`DELETE FROM invoice_recipients WHERE invoice_id = $1`, [issued]),
      (c) => addLine(c, issued, { n: 2 }),
      (c) => addRecipient(c, issued, ids.tenant),
    ];
    for (const attempt of attempts) {
      await expect(inTenant(ids.org, attempt)).rejects.toMatchObject({
        code: expect.stringMatching(/^(23514|42501)$/),
      });
    }
  });

  it('while drafts can be edited and discarded', async () => {
    await inTenant(ids.org, async (c) => {
      const invoice = await readyDraft(c, { month: null });
      await c.query(`UPDATE invoices SET due_date = '2027-02-28' WHERE id = $1`, [invoice]);
      await c.query('DELETE FROM invoice_lines WHERE invoice_id = $1', [invoice]);
      await c.query('DELETE FROM invoice_recipients WHERE invoice_id = $1', [invoice]);
      await c.query('DELETE FROM invoices WHERE id = $1', [invoice]);
    });
  });

  it('cannot be moved to another unit while still a draft', async () => {
    await expect(
      inTenant(ids.org, async (c) => {
        const invoice = await draftInvoice(c, { month: null });
        await c.query('UPDATE invoices SET unit_id = $2 WHERE id = $1', [invoice, ids.unit2]);
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

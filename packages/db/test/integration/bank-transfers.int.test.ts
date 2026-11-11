import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Residents' bank-transfer submissions (migration 20261113090000_bank_transfers): only a current
 * owner reports a transfer for the owners and only a current tenant for their tenancy; dates in
 * the future, other currencies and untrimmed text are refused; at most 10 wait per party; a
 * submission is decided once, never by its submitter, and a confirmation names a matching
 * BANK_TRANSFER payment; rows are tenant-isolated and never deleted. Runs as veyra_app unless
 * stated.
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
  otherOrg: randomUUID(),
  prop: randomUUID(),
  unit1: randomUUID(),
  unit2: randomUUID(),
  ownerUser: randomUUID(),
  tenantUser: randomUUID(),
  strangerUser: randomUUID(),
  clerk: randomUUID(),
  ownerPerson: randomUUID(),
  tenantPerson: randomUUID(),
  tenancy: randomUUID(),
  bank: randomUUID(),
  credit: randomUUID(),
};
/** Today in the property's time zone, from the database's own clock. */
let today: string;

interface Submission {
  unit?: string;
  paidBy?: 'OWNERS' | 'TENANTS';
  tenancy?: string | null;
  amount?: number;
  currency?: string;
  date?: string;
  reference?: string;
  user?: string;
}

async function submit(c: pg.PoolClient, input: Submission = {}): Promise<string> {
  const id = randomUUID();
  const paidBy = input.paidBy ?? 'OWNERS';
  await c.query(
    `INSERT INTO bank_transfer_submissions (id, organisation_id, property_id, unit_id, paid_by, tenancy_id,
       amount_minor, currency, transferred_on, reference, submitted_by_user_id, idempotency_key, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())`,
    [
      id,
      ids.org,
      ids.prop,
      input.unit ?? ids.unit1,
      paidBy,
      input.tenancy === undefined ? (paidBy === 'TENANTS' ? ids.tenancy : null) : input.tenancy,
      input.amount ?? 250000,
      input.currency ?? 'PKR',
      input.date ?? today,
      input.reference ?? 'FT-12345',
      input.user ?? (paidBy === 'TENANTS' ? ids.tenantUser : ids.ownerUser),
      randomUUID(),
    ],
  );
  return id;
}

/** A recorded payment with its posted entry (BANK_TRANSFER unless stated). */
async function payment(
  c: pg.PoolClient,
  input: { amount?: number; tenancy?: string | null; method?: string } = {},
): Promise<string> {
  const amount = input.amount ?? 250000;
  const entryId = randomUUID();
  await c.query(
    `INSERT INTO journal_entries (id, organisation_id, property_id, entry_date, description, source, currency, updated_at)
     VALUES ($1, $2, $3, $4, 'Test', 'PAYMENT', 'PKR', now())`,
    [entryId, ids.org, ids.prop, today],
  );
  for (const [n, account, unit, debit, credit] of [
    [1, ids.bank, null, amount, 0],
    [2, ids.credit, ids.unit1, 0, amount],
  ] as const) {
    await c.query(
      `INSERT INTO journal_lines (id, organisation_id, property_id, entry_id, line_number, account_id, unit_id,
         debit_minor, credit_minor, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PKR')`,
      [randomUUID(), ids.org, ids.prop, entryId, n, account, unit, debit, credit],
    );
  }
  await c.query(`UPDATE journal_entries SET status = 'POSTED' WHERE id = $1`, [entryId]);
  const id = randomUUID();
  await c.query(
    `INSERT INTO payments (id, organisation_id, property_id, unit_id, paid_by, tenancy_id, method, amount_minor,
       currency, received_on, journal_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PKR', $9, $10)`,
    [
      id,
      ids.org,
      ids.prop,
      ids.unit1,
      input.tenancy ? 'TENANTS' : 'OWNERS',
      input.tenancy ?? null,
      input.method ?? 'BANK_TRANSFER',
      amount,
      today,
      entryId,
    ],
  );
  return id;
}

const confirm = (c: pg.PoolClient, id: string, paymentId: string | null, by = ids.clerk) =>
  c.query(
    `UPDATE bank_transfer_submissions
        SET status = 'CONFIRMED', payment_id = $2, decided_by_user_id = $3, decided_at = now()
      WHERE id = $1`,
    [id, paymentId, by],
  );

const reject = (c: pg.PoolClient, id: string, reason: string | null, by = ids.clerk) =>
  c.query(
    `UPDATE bank_transfer_submissions
        SET status = 'REJECTED', rejection_reason = $2, decided_by_user_id = $3, decided_at = now()
      WHERE id = $1`,
    [id, reason, by],
  );

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 4 });
  superuser = new pg.Pool({ connectionString: inject('superuserDatabaseUrl'), max: 1 });
  today = (
    await app.query<{ d: string }>(
      `SELECT to_char((now() AT TIME ZONE 'Asia/Karachi')::date, 'YYYY-MM-DD') AS d`,
    )
  ).rows[0]?.d as string;
  for (const [id, name] of [
    [ids.ownerUser, 'Owner'],
    [ids.tenantUser, 'Tenant'],
    [ids.strangerUser, 'Stranger'],
    [ids.clerk, 'Clerk'],
  ] as const) {
    await app.query(
      `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, $3, now())`,
      [id, `transfers-${id}@example.test`, name],
    );
  }
  for (const org of [ids.org, ids.otherOrg]) {
    await inTenant(org, (c) =>
      c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `bt-${org.slice(0, 8)}`],
      ),
    );
  }
  await inTenant(ids.org, async (c) => {
    await c.query(
      `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
       VALUES ($1, $2, 'Transfer Court', 'BT', 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
      [ids.prop, ids.org],
    );
    for (const [unit, number] of [
      [ids.unit1, 'T1'],
      [ids.unit2, 'T2'],
    ] as const) {
      await c.query(
        `INSERT INTO units (id, organisation_id, property_id, number, type, updated_at)
         VALUES ($1, $2, $3, $4, 'APARTMENT', now())`,
        [unit, ids.org, ids.prop, number],
      );
    }
    for (const [id, code, type, key] of [
      [ids.bank, '1000', 'ASSET', 'BANK'],
      [ids.credit, '2100', 'LIABILITY', 'UNIT_CREDIT'],
    ] as const) {
      await c.query(
        `INSERT INTO ledger_accounts (id, organisation_id, property_id, code, name, type, system_key, updated_at)
         VALUES ($1, $2, $3, $4, 'Account', $5, $6, now())`,
        [id, ids.org, ids.prop, code, type, key],
      );
    }
    await c.query(
      `INSERT INTO accounting_periods (id, organisation_id, property_id, start_date, end_date, updated_at)
       VALUES ($1, $2, $3, date_trunc('month', $4::date)::date,
               (date_trunc('month', $4::date) + interval '1 month - 1 day')::date, now())`,
      [randomUUID(), ids.org, ids.prop, today],
    );
    for (const [id, name, user] of [
      [ids.ownerPerson, 'Olu Owner', ids.ownerUser],
      [ids.tenantPerson, 'Tia Tenant', ids.tenantUser],
    ] as const) {
      await c.query(
        `INSERT INTO persons (id, organisation_id, full_name, user_id, updated_at) VALUES ($1, $2, $3, $4, now())`,
        [id, ids.org, name, user],
      );
    }
    await c.query(
      `INSERT INTO ownerships (id, organisation_id, property_id, unit_id, person_id, share_numerator,
         share_denominator, effective_from, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, 1, '2026-01-01', now())`,
      [randomUUID(), ids.org, ids.prop, ids.unit1, ids.ownerPerson],
    );
    await c.query(
      `INSERT INTO tenancies (id, organisation_id, property_id, unit_id, start_date, updated_at)
       VALUES ($1, $2, $3, $4, '2026-01-01', now())`,
      [ids.tenancy, ids.org, ids.prop, ids.unit1],
    );
    await c.query(
      `INSERT INTO tenancy_occupants (id, organisation_id, tenancy_id, person_id, is_primary)
       VALUES ($1, $2, $3, $4, true)`,
      [randomUUID(), ids.org, ids.tenancy, ids.tenantPerson],
    );
  });
});

afterAll(async () => {
  await app?.end();
  await superuser?.end();
});

describe('who may submit', () => {
  it('accepts a current owner for the owners and a current tenant for their tenancy', async () => {
    await inTenant(ids.org, async (c) => {
      const owners = await submit(c);
      const tenants = await submit(c, { paidBy: 'TENANTS' });
      const { rows } = await c.query(
        `SELECT status FROM bank_transfer_submissions WHERE id = ANY($1::uuid[])`,
        [[owners, tenants]],
      );
      expect(rows.map((r) => r.status)).toEqual(['PENDING', 'PENDING']);
    });
  });

  it.each([
    ['a tenant for the owners', { paidBy: 'OWNERS' as const, user: ids.tenantUser }],
    ['an owner for the tenancy', { paidBy: 'TENANTS' as const, user: ids.ownerUser }],
    ['someone with no records', { user: ids.strangerUser }],
    ['an owner for another unit', { unit: ids.unit2 }],
  ])('refuses %s', async (_name, input) => {
    await expect(inTenant(ids.org, (c) => submit(c, input))).rejects.toThrow(/only a/);
  });

  it('refuses a tenancy of another unit and a party without its tenancy', async () => {
    await expect(
      inTenant(ids.org, (c) => submit(c, { paidBy: 'TENANTS', unit: ids.unit2 })),
    ).rejects.toThrow(/only a tenant/);
    await expect(
      inTenant(ids.org, (c) => submit(c, { paidBy: 'TENANTS', tenancy: null })),
    ).rejects.toThrow(/only a tenant|bank_transfer_submissions_party/);
  });

  it('refuses a future date, another currency, a zero amount and untrimmed text', async () => {
    const tomorrow = new Date(`${today}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    await expect(
      inTenant(ids.org, (c) => submit(c, { date: tomorrow.toISOString().slice(0, 10) })),
    ).rejects.toThrow(/future/);
    await expect(inTenant(ids.org, (c) => submit(c, { currency: 'USD' }))).rejects.toThrow(
      /currency/,
    );
    await expect(inTenant(ids.org, (c) => submit(c, { amount: 0 }))).rejects.toThrow(
      /amount_positive/,
    );
    await expect(inTenant(ids.org, (c) => submit(c, { reference: ' FT-1 ' }))).rejects.toThrow(
      /reference_trimmed/,
    );
  });

  it('keeps at most 10 submissions waiting per party', async () => {
    await inTenant(ids.org, async (c) => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM bank_transfer_submissions
          WHERE unit_id = $1 AND paid_by = 'TENANTS' AND status = 'PENDING'`,
        [ids.unit1],
      );
      for (let i = rows[0].n; i < 10; i++) await submit(c, { paidBy: 'TENANTS' });
    });
    await expect(inTenant(ids.org, (c) => submit(c, { paidBy: 'TENANTS' }))).rejects.toThrow(
      /too many/,
    );
    // Deciding one makes room again.
    await inTenant(ids.org, async (c) => {
      const { rows } = await c.query(
        `SELECT id FROM bank_transfer_submissions WHERE unit_id = $1 AND paid_by = 'TENANTS'
            AND status = 'PENDING' LIMIT 1`,
        [ids.unit1],
      );
      await reject(c, rows[0].id, 'Not found on the statement');
      await submit(c, { paidBy: 'TENANTS' });
    });
  });
});

describe('deciding', () => {
  it('is never done by the submitter', async () => {
    const id = await inTenant(ids.org, (c) => submit(c));
    await expect(inTenant(ids.org, (c) => reject(c, id, 'Mine', ids.ownerUser))).rejects.toThrow(
      /bank_transfer_submissions_decision/,
    );
  });

  it('needs a reason to reject and a payment to confirm', async () => {
    const id = await inTenant(ids.org, (c) => submit(c));
    await expect(inTenant(ids.org, (c) => reject(c, id, null))).rejects.toThrow(
      /bank_transfer_submissions_decision/,
    );
    // The trigger runs before the CHECK: either refusal is fine.
    await expect(inTenant(ids.org, (c) => confirm(c, id, null))).rejects.toThrow(
      /same unit, party and amount|bank_transfer_submissions_decision/,
    );
  });

  it('confirms only with a bank-transfer payment of the same party and amount', async () => {
    const id = await inTenant(ids.org, (c) => submit(c));
    for (const wrong of [{ amount: 100 }, { tenancy: ids.tenancy }, { method: 'CASH' }]) {
      await expect(
        inTenant(ids.org, async (c) => confirm(c, id, await payment(c, wrong))),
      ).rejects.toThrow(/same unit, party and amount/);
    }
    await inTenant(ids.org, async (c) => confirm(c, id, await payment(c)));
    const { rows } = await inTenant(ids.org, (c) =>
      c.query(`SELECT status, payment_id FROM bank_transfer_submissions WHERE id = $1`, [id]),
    );
    expect(rows[0].status).toBe('CONFIRMED');
    expect(rows[0].payment_id).not.toBeNull();
  });

  it('decides once and never changes what was reported', async () => {
    const id = await inTenant(ids.org, (c) => submit(c));
    await inTenant(ids.org, (c) => reject(c, id, 'Not received'));
    await expect(inTenant(ids.org, (c) => reject(c, id, 'Again'))).rejects.toThrow(/decided once/);
    const pending = await inTenant(ids.org, (c) => submit(c));
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`UPDATE bank_transfer_submissions SET amount_minor = 1 WHERE id = $1`, [pending]),
      ),
    ).rejects.toThrow(/never changes/);
  });

  it('starts pending', async () => {
    await expect(
      inTenant(ids.org, (c) =>
        c.query(
          `INSERT INTO bank_transfer_submissions (id, organisation_id, property_id, unit_id, paid_by, amount_minor,
             currency, transferred_on, reference, status, submitted_by_user_id, idempotency_key,
             decided_by_user_id, decided_at, rejection_reason, updated_at)
           VALUES ($1, $2, $3, $4, 'OWNERS', 100, 'PKR', $5, 'X', 'REJECTED', $6, $7, $8, now(), 'No', now())`,
          [
            randomUUID(),
            ids.org,
            ids.prop,
            ids.unit1,
            today,
            ids.ownerUser,
            randomUUID(),
            ids.clerk,
          ],
        ),
      ),
    ).rejects.toThrow(/start pending/);
  });
});

describe('isolation', () => {
  it('is invisible to another organisation and cannot be written there', async () => {
    const { rows } = await inTenant(ids.otherOrg, (c) =>
      c.query(`SELECT count(*)::int AS n FROM bank_transfer_submissions`),
    );
    expect(rows[0].n).toBe(0);
    await expect(inTenant(ids.otherOrg, (c) => submit(c))).rejects.toThrow();
  });

  it('cannot be deleted by the application', async () => {
    const id = await inTenant(ids.org, (c) => submit(c));
    await expect(
      inTenant(ids.org, (c) =>
        c.query(`DELETE FROM bank_transfer_submissions WHERE id = $1`, [id]),
      ),
    ).rejects.toThrow(/permission denied/);
    const { rows } = await superuser.query(
      `SELECT count(*)::int AS n FROM bank_transfer_submissions WHERE id = $1`,
      [id],
    );
    expect(rows[0].n).toBe(1);
  });
});

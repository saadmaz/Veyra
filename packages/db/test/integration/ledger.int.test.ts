import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

/**
 * Finance ledger (migration 20261112090000_ledger): tenant and property isolation, accounts and
 * periods, posting rules (balance, open period, active accounts, currency), gap-free entry
 * numbers, immutability of posted entries (even for the superuser), reversals, the property
 * currency lock and the locks that serialise posting with conflicting changes.
 * Runs as veyra_app unless stated.
 */

let app: pg.Pool;
let superuser: pg.Pool;
let owner: pg.Pool;

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

/** Opens a transaction in tenant context and leaves it open (for lock tests). */
async function openTenantTransaction(organisationId: string): Promise<pg.PoolClient> {
  const client = await app.connect();
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.organisation_id', $1, true)", [organisationId]);
  return client;
}

const ids = {
  orgA: randomUUID(),
  orgB: randomUUID(),
  propA: randomUUID(),
  propA2: randomUUID(),
  propB: randomUUID(),
  propEmpty: randomUUID(),
  unitA: randomUUID(),
  unitA2: randomUUID(),
  clerk: randomUUID(),
};

/** Accounts per property, by role in the tests. */
interface PropertyAccounts {
  bank: string;
  receivables: string;
  income: string;
  old: string;
}
const acct = new Map<string, PropertyAccounts>();
const acctOf = (prop: string): PropertyAccounts => {
  const found = acct.get(prop);
  if (!found) throw new Error(`no accounts for property ${prop}`);
  return found;
};

let codeCounter = 0;
const account = (
  c: pg.PoolClient,
  input: { org?: string; prop?: string; type?: string; systemKey?: string | null; code?: string },
) => {
  const id = randomUUID();
  codeCounter += 1;
  return c
    .query(
      `INSERT INTO ledger_accounts (id, organisation_id, property_id, code, name, type, system_key, updated_at)
       VALUES ($1, $2, $3, $4, 'Test account', $5, $6, now())`,
      [
        id,
        input.org ?? ids.orgA,
        input.prop ?? ids.propA,
        input.code ?? `T${codeCounter}`,
        input.type ?? 'ASSET',
        input.systemKey ?? null,
      ],
    )
    .then(() => id);
};

const period = (
  c: pg.PoolClient,
  input: { org?: string; prop?: string; start: string; end: string; closed?: boolean },
) => {
  const id = randomUUID();
  return c
    .query(
      `INSERT INTO accounting_periods (id, organisation_id, property_id, start_date, end_date, status, closed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
      [
        id,
        input.org ?? ids.orgA,
        input.prop ?? ids.propA,
        input.start,
        input.end,
        input.closed ? 'CLOSED' : 'OPEN',
        input.closed ? new Date().toISOString() : null,
      ],
    )
    .then(() => id);
};

interface DraftInput {
  org?: string;
  prop?: string;
  date?: string;
  currency?: string;
  reverses?: string;
  status?: string;
}

const draft = (c: pg.PoolClient, input: DraftInput = {}) => {
  const id = randomUUID();
  return c
    .query(
      `INSERT INTO journal_entries (id, organisation_id, property_id, entry_date, description, source, currency,
         status, reverses_entry_id, created_by_user_id, updated_at)
       VALUES ($1, $2, $3, $4, 'Test entry', $5, $6, $7, $8, $9, now())`,
      [
        id,
        input.org ?? ids.orgA,
        input.prop ?? ids.propA,
        input.date ?? '2027-01-15',
        input.reverses ? 'REVERSAL' : 'MANUAL',
        input.currency ?? 'PKR',
        input.status ?? 'DRAFT',
        input.reverses ?? null,
        ids.clerk,
      ],
    )
    .then(() => id);
};

interface LineInput {
  account: string;
  debit?: bigint | number;
  credit?: bigint | number;
  unit?: string | null;
  n: number;
  org?: string;
  prop?: string;
  currency?: string;
}

const line = (c: pg.PoolClient, entryId: string, input: LineInput) =>
  c.query(
    `INSERT INTO journal_lines (id, organisation_id, property_id, entry_id, line_number, account_id, unit_id,
       debit_minor, credit_minor, currency)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      randomUUID(),
      input.org ?? ids.orgA,
      input.prop ?? ids.propA,
      entryId,
      input.n,
      input.account,
      input.unit ?? null,
      String(input.debit ?? 0),
      String(input.credit ?? 0),
      input.currency ?? 'PKR',
    ],
  );

const post = (c: pg.PoolClient, entryId: string) =>
  c.query(
    `UPDATE journal_entries SET status = 'POSTED', posted_by_user_id = $2, updated_at = now() WHERE id = $1
     RETURNING entry_number, posted_at`,
    [entryId, ids.clerk],
  );

/** A balanced two-line draft: debit receivables (unit A), credit income. */
const balancedDraft = async (
  c: pg.PoolClient,
  amount: bigint | number = 150_000,
  input: DraftInput = {},
) => {
  const prop = input.prop ?? ids.propA;
  const org = input.org ?? ids.orgA;
  const entry = await draft(c, input);
  await line(c, entry, {
    n: 1,
    account: acctOf(prop).receivables,
    debit: amount,
    unit: prop === ids.propA ? ids.unitA : null,
    org,
    prop,
  });
  await line(c, entry, { n: 2, account: acctOf(prop).income, credit: amount, org, prop });
  return entry;
};

beforeAll(async () => {
  app = new pg.Pool({ connectionString: inject('appDatabaseUrl'), max: 6 });
  superuser = new pg.Pool({ connectionString: inject('superuserDatabaseUrl'), max: 2 });
  owner = new pg.Pool({ connectionString: inject('ownerDatabaseUrl'), max: 2 });

  await app.query(
    `INSERT INTO users (id, email, display_name, updated_at) VALUES ($1, $2, 'Ledger Clerk', now())`,
    [ids.clerk, `clerk-${ids.clerk}@example.test`],
  );
  for (const [org, props] of [
    [
      ids.orgA,
      [
        [ids.propA, 'LA', ids.unitA],
        [ids.propA2, 'LB', ids.unitA2],
        [ids.propEmpty, 'LE', null],
      ],
    ],
    [ids.orgB, [[ids.propB, 'LC', null]]],
  ] as const) {
    await inTenant(org, async (c) => {
      await c.query(
        `INSERT INTO organisations (id, name, slug, country_code, default_currency, default_time_zone, updated_at)
         VALUES ($1, $2, $2, 'PK', 'PKR', 'Asia/Karachi', now())`,
        [org, `led-${org.slice(0, 8)}`],
      );
      for (const [prop, code, unit] of props) {
        await c.query(
          `INSERT INTO properties (id, organisation_id, name, code, type, address_line1, city, country_code, time_zone, currency, updated_at)
           VALUES ($1, $2, 'Ledger Court', $3, 'CONDOMINIUM', '1 Road', 'Karachi', 'PK', 'Asia/Karachi', 'PKR', now())`,
          [prop, org, code],
        );
        if (unit) {
          await c.query(
            `INSERT INTO units (id, organisation_id, property_id, number, type, updated_at)
             VALUES ($1, $2, $3, 'L1', 'APARTMENT', now())`,
            [unit, org, prop],
          );
        }
        if (prop === ids.propEmpty) continue;
        acct.set(prop, {
          bank: await account(c, { org, prop, type: 'ASSET', systemKey: 'BANK' }),
          receivables: await account(c, { org, prop, type: 'ASSET', systemKey: 'RECEIVABLES' }),
          income: await account(c, { org, prop, type: 'INCOME' }),
          old: await account(c, { org, prop, type: 'EXPENSE' }),
        });
        await c.query(
          `UPDATE ledger_accounts SET status = 'ARCHIVED', archived_at = now() WHERE id = $1`,
          [acctOf(prop).old],
        );
        await period(c, { org, prop, start: '2026-12-01', end: '2026-12-31', closed: true });
        await period(c, { org, prop, start: '2027-01-01', end: '2027-01-31' });
      }
    });
  }
});

afterAll(async () => {
  await app?.end();
  await superuser?.end();
  await owner?.end();
});

describe('tenant and property isolation', () => {
  it.each(['ledger_accounts', 'accounting_periods', 'journal_entries', 'journal_lines'])(
    'shows nothing in %s without tenant context',
    async (table) => {
      await inTenant(ids.orgA, (c) => balancedDraft(c));
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n).toBe(0);
    },
  );

  it("hides one tenant's ledger from another", async () => {
    const entry = await inTenant(ids.orgA, (c) => balancedDraft(c));
    const seen = await inTenant(ids.orgB, async (c) => ({
      entries: (await c.query('SELECT 1 FROM journal_entries WHERE id = $1', [entry])).rowCount,
      lines: (await c.query('SELECT 1 FROM journal_lines WHERE entry_id = $1', [entry])).rowCount,
      accounts: (
        await c.query('SELECT 1 FROM ledger_accounts WHERE id = $1', [acctOf(ids.propA).bank])
      ).rowCount,
    }));
    expect(seen).toEqual({ entries: 0, lines: 0, accounts: 0 });
  });

  it("refuses rows filed under another tenant's organisation", async () => {
    await expect(
      inTenant(ids.orgA, (c) => draft(c, { org: ids.orgB, prop: ids.propB })),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it("rejects lines that point at another property's account, unit or entry currency", async () => {
    // Account of another property of the same organisation.
    await expect(
      inTenant(ids.orgA, async (c) => {
        const entry = await draft(c);
        await line(c, entry, { n: 1, account: acctOf(ids.propA2).bank, debit: 100 });
      }),
    ).rejects.toMatchObject({ code: '23503' });
    // Unit of another property.
    await expect(
      inTenant(ids.orgA, async (c) => {
        const entry = await draft(c);
        await line(c, entry, {
          n: 1,
          account: acctOf(ids.propA).receivables,
          debit: 100,
          unit: ids.unitA2,
        });
      }),
    ).rejects.toMatchObject({ code: '23503' });
    // A line in another currency than its entry.
    await expect(
      inTenant(ids.orgA, async (c) => {
        const entry = await draft(c);
        await line(c, entry, {
          n: 1,
          account: acctOf(ids.propA).bank,
          debit: 100,
          currency: 'USD',
        });
      }),
    ).rejects.toMatchObject({ code: '23503' });
    // A reversal of another property's entry.
    const other = await inTenant(ids.orgA, async (c) => {
      const entry = await balancedDraft(c, 100, { prop: ids.propA2 });
      await post(c, entry);
      return entry;
    });
    await expect(inTenant(ids.orgA, (c) => draft(c, { reverses: other }))).rejects.toMatchObject({
      code: '23503',
    });
  });
});

describe('accounts', () => {
  it('enforces code format, unique codes and unique system keys per property', async () => {
    await expect(inTenant(ids.orgA, (c) => account(c, { code: 'bad code' }))).rejects.toMatchObject(
      { code: '23514' },
    );
    await expect(
      inTenant(ids.orgA, async (c) => {
        await account(c, { code: 'DUP-1' });
        await account(c, { code: 'DUP-1' });
      }),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      inTenant(ids.orgA, (c) => account(c, { systemKey: 'BANK' })),
    ).rejects.toMatchObject({ code: '23505' });
    // The same system key in another property is fine.
    await inTenant(ids.orgA, (c) => account(c, { prop: ids.propEmpty, systemKey: 'BANK' }));
  });

  it('keeps an account in its property and its type once used', async () => {
    const unused = await inTenant(ids.orgA, (c) => account(c, { type: 'ASSET' }));
    await inTenant(ids.orgA, (c) =>
      c.query(`UPDATE ledger_accounts SET type = 'EXPENSE' WHERE id = $1`, [unused]),
    );
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query(`UPDATE ledger_accounts SET property_id = $2 WHERE id = $1`, [unused, ids.propA2]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query(`UPDATE ledger_accounts SET system_key = 'NEW_KEY' WHERE id = $1`, [unused]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await inTenant(ids.orgA, (c) => balancedDraft(c));
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query(`UPDATE ledger_accounts SET type = 'EXPENSE' WHERE id = $1`, [
          acctOf(ids.propA).income,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('cannot be deleted by the application', async () => {
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query('DELETE FROM ledger_accounts WHERE id = $1', [acctOf(ids.propA).old]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('accounting periods', () => {
  it('never overlap within a property, but may across properties', async () => {
    await expect(
      inTenant(ids.orgA, (c) => period(c, { start: '2027-01-31', end: '2027-02-27' })),
    ).rejects.toMatchObject({ code: '23P01' });
    await inTenant(ids.orgA, (c) =>
      period(c, { prop: ids.propEmpty, start: '2027-01-01', end: '2027-01-31' }),
    );
  });

  it('are at most a year long, end after they start and never move', async () => {
    await expect(
      inTenant(ids.orgA, (c) => period(c, { start: '2030-01-01', end: '2031-01-01' })),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      inTenant(ids.orgA, (c) => period(c, { start: '2030-02-01', end: '2030-01-31' })),
    ).rejects.toMatchObject({ code: '23514' });
    const id = await inTenant(ids.orgA, (c) =>
      period(c, { start: '2029-01-01', end: '2029-01-31' }),
    );
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query(`UPDATE accounting_periods SET end_date = '2029-02-28' WHERE id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    // Closing records when; reopening is a status change (who may reopen is the API's rule).
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query(`UPDATE accounting_periods SET status = 'CLOSED' WHERE id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await inTenant(ids.orgA, (c) =>
      c.query(
        `UPDATE accounting_periods SET status = 'CLOSED', closed_at = now(), closed_by_user_id = $2 WHERE id = $1`,
        [id, ids.clerk],
      ),
    );
    await inTenant(ids.orgA, (c) =>
      c.query(
        `UPDATE accounting_periods SET status = 'OPEN', closed_at = NULL, closed_by_user_id = NULL WHERE id = $1`,
        [id],
      ),
    );
  });
});

describe('posting', () => {
  it('posts a balanced entry and stamps it', async () => {
    const result = await inTenant(ids.orgA, async (c) => {
      const entry = await balancedDraft(c, 1_234_567);
      return (await post(c, entry)).rows[0];
    });
    expect(Number(result.entry_number)).toBeGreaterThanOrEqual(1);
    expect(result.posted_at).toBeInstanceOf(Date);
  });

  it('numbers entries per property without gaps', async () => {
    const numbers = await inTenant(ids.orgA, async (c) => {
      const out: number[] = [];
      for (let i = 0; i < 3; i++) {
        const entry = await balancedDraft(c, 100, { prop: ids.propA2 });
        out.push(Number((await post(c, entry)).rows[0].entry_number));
      }
      return out;
    });
    const [first, second, third] = numbers as [number, number, number];
    expect([second, third]).toEqual([first + 1, first + 2]);
    // Another tenant's property starts at 1.
    const otherTenantFirst = await inTenant(ids.orgB, async (c) => {
      const entry = await balancedDraft(c, 100, { org: ids.orgB, prop: ids.propB });
      return Number((await post(c, entry)).rows[0].entry_number);
    });
    expect(otherTenantFirst).toBe(1);
  });

  it('refuses entries that are not balanced or have a single line', async () => {
    await expect(
      inTenant(ids.orgA, async (c) => {
        const entry = await draft(c);
        await line(c, entry, { n: 1, account: acctOf(ids.propA).bank, debit: 100 });
        await line(c, entry, { n: 2, account: acctOf(ids.propA).income, credit: 99 });
        await post(c, entry);
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/not balanced/) });
    await expect(
      inTenant(ids.orgA, async (c) => {
        const entry = await draft(c);
        await line(c, entry, { n: 1, account: acctOf(ids.propA).bank, debit: 100 });
        await post(c, entry);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(inTenant(ids.orgA, async (c) => post(c, await draft(c)))).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('refuses lines with both sides, neither side or a negative amount', async () => {
    for (const [debit, credit] of [
      [100, 100],
      [0, 0],
      [-100, 0],
    ]) {
      await expect(
        inTenant(ids.orgA, async (c) => {
          const entry = await draft(c);
          await line(c, entry, { n: 1, account: acctOf(ids.propA).bank, debit, credit });
        }),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('keeps amounts beyond the safe integer range exact', async () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const total = await inTenant(ids.orgA, async (c) => {
      const entry = await balancedDraft(c, huge);
      await post(c, entry);
      return (
        await c.query('SELECT sum(debit_minor)::text AS d FROM journal_lines WHERE entry_id = $1', [
          entry,
        ])
      ).rows[0].d;
    });
    expect(total).toBe(huge.toString());
  });

  it('refuses a date outside an open period', async () => {
    for (const date of ['2026-12-15', '2027-03-01']) {
      await expect(
        inTenant(ids.orgA, async (c) => post(c, await balancedDraft(c, 100, { date }))),
      ).rejects.toMatchObject({
        code: '23514',
        message: expect.stringMatching(/no open accounting period/),
      });
    }
  });

  it('refuses archived accounts, a foreign currency and an archived property', async () => {
    await expect(
      inTenant(ids.orgA, async (c) => {
        const entry = await draft(c);
        await line(c, entry, { n: 1, account: acctOf(ids.propA).old, debit: 100 });
        await line(c, entry, { n: 2, account: acctOf(ids.propA).income, credit: 100 });
        await post(c, entry);
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/archived account/) });
    await expect(
      inTenant(ids.orgA, async (c) => {
        const entry = await draft(c, { currency: 'USD' });
        await line(c, entry, {
          n: 1,
          account: acctOf(ids.propA).bank,
          debit: 100,
          currency: 'USD',
        });
        await line(c, entry, {
          n: 2,
          account: acctOf(ids.propA).income,
          credit: 100,
          currency: 'USD',
        });
        await post(c, entry);
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/property currency/) });
    await expect(
      inTenant(ids.orgA, async (c) => {
        const entry = await balancedDraft(c);
        await c.query(
          `UPDATE properties SET status = 'ARCHIVED', archived_at = now() WHERE id = $1`,
          [ids.propA],
        );
        await post(c, entry);
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/archived/) });
  });

  it('refuses entries inserted as already posted', async () => {
    await expect(inTenant(ids.orgA, (c) => draft(c, { status: 'POSTED' }))).rejects.toMatchObject({
      code: '23514',
    });
  });
});

describe('immutability', () => {
  let posted: string;

  beforeAll(async () => {
    posted = await inTenant(ids.orgA, async (c) => {
      const entry = await balancedDraft(c, 500);
      await post(c, entry);
      return entry;
    });
  });

  it('refuses any change to a posted entry or its lines', async () => {
    const attempts = [
      `UPDATE journal_entries SET description = 'Changed' WHERE id = $1`,
      `UPDATE journal_entries SET status = 'DRAFT', posted_at = NULL, entry_number = NULL WHERE id = $1`,
      `DELETE FROM journal_entries WHERE id = $1`,
      `UPDATE journal_lines SET debit_minor = debit_minor * 2 WHERE entry_id = $1 AND debit_minor > 0`,
      `DELETE FROM journal_lines WHERE entry_id = $1`,
    ];
    for (const sql of attempts) {
      await expect(inTenant(ids.orgA, (c) => c.query(sql, [posted]))).rejects.toMatchObject({
        code: expect.stringMatching(/^(23514|42501)$/),
      });
    }
    await expect(
      inTenant(ids.orgA, (c) =>
        line(c, posted, { n: 3, account: acctOf(ids.propA).bank, debit: 1 }),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('holds for the superuser and the schema owner too', async () => {
    await expect(
      superuser.query(`UPDATE journal_lines SET credit_minor = 1 WHERE entry_id = $1`, [posted]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      superuser.query(`UPDATE journal_entries SET entry_date = '2027-01-02' WHERE id = $1`, [
        posted,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(superuser.query('TRUNCATE journal_lines, journal_entries')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(owner.query('TRUNCATE journal_lines')).rejects.toMatchObject({ code: '42501' });
  });

  it('lets drafts change and be discarded', async () => {
    await inTenant(ids.orgA, async (c) => {
      const entry = await balancedDraft(c, 700);
      await c.query(`UPDATE journal_entries SET description = 'Edited draft' WHERE id = $1`, [
        entry,
      ]);
      await c.query(`UPDATE journal_lines SET description = 'Edited line' WHERE entry_id = $1`, [
        entry,
      ]);
      await c.query('DELETE FROM journal_lines WHERE entry_id = $1', [entry]);
      await c.query('DELETE FROM journal_entries WHERE id = $1', [entry]);
    });
  });

  it('refuses a draft that moves or gets a number by hand', async () => {
    await expect(
      inTenant(ids.orgA, async (c) => {
        const entry = await draft(c);
        await c.query('UPDATE journal_entries SET property_id = $2 WHERE id = $1', [
          entry,
          ids.propA2,
        ]);
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      inTenant(ids.orgA, async (c) => {
        const entry = await draft(c);
        await c.query('UPDATE journal_entries SET entry_number = 999 WHERE id = $1', [entry]);
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('reversals', () => {
  const postedEntry = (amount = 900) =>
    inTenant(ids.orgA, async (c) => {
      const entry = await balancedDraft(c, amount);
      await post(c, entry);
      return entry;
    });

  const mirror = (c: pg.PoolClient, entry: string, amount = 900) =>
    Promise.all([
      line(c, entry, { n: 1, account: acctOf(ids.propA).income, debit: amount }),
      line(c, entry, {
        n: 2,
        account: acctOf(ids.propA).receivables,
        credit: amount,
        unit: ids.unitA,
      }),
    ]);

  it('posts a mirror image of a posted entry, after which the two net to zero', async () => {
    const original = await postedEntry();
    const net = await inTenant(ids.orgA, async (c) => {
      const reversal = await draft(c, { reverses: original, date: '2027-01-20' });
      await mirror(c, reversal);
      await post(c, reversal);
      return (
        await c.query(
          `SELECT account_id, unit_id, sum(debit_minor - credit_minor)::text AS net
             FROM journal_lines WHERE entry_id IN ($1, $2) GROUP BY account_id, unit_id`,
          [original, reversal],
        )
      ).rows.map((r) => r.net);
    });
    expect(net).toEqual(['0', '0']);
  });

  it('refuses a reversal that does not mirror, is dated earlier or reverses a draft', async () => {
    const original = await postedEntry();
    await expect(
      inTenant(ids.orgA, async (c) => {
        const reversal = await draft(c, { reverses: original });
        await mirror(c, reversal, 800);
        await post(c, reversal);
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/mirror/) });
    // Same amounts, but the unit is missing on the receivables line.
    await expect(
      inTenant(ids.orgA, async (c) => {
        const reversal = await draft(c, { reverses: original });
        await line(c, reversal, { n: 1, account: acctOf(ids.propA).income, debit: 900 });
        await line(c, reversal, { n: 2, account: acctOf(ids.propA).receivables, credit: 900 });
        await post(c, reversal);
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/mirror/) });
    await expect(
      inTenant(ids.orgA, async (c) => {
        const reversal = await draft(c, { reverses: original, date: '2027-01-14' });
        await mirror(c, reversal);
        await post(c, reversal);
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/before/) });
    await expect(
      inTenant(ids.orgA, async (c) => {
        const unposted = await balancedDraft(c, 900);
        const reversal = await draft(c, { reverses: unposted });
        await mirror(c, reversal);
        await post(c, reversal);
      }),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/posted entry/) });
  });

  it('reverses an entry at most once', async () => {
    const original = await postedEntry();
    await inTenant(ids.orgA, async (c) => {
      const reversal = await draft(c, { reverses: original });
      await mirror(c, reversal);
      await post(c, reversal);
    });
    await expect(inTenant(ids.orgA, (c) => draft(c, { reverses: original }))).rejects.toMatchObject(
      { code: '23505' },
    );
  });
});

describe('property currency', () => {
  it('is fixed once the property has ledger entries', async () => {
    await expect(
      inTenant(ids.orgA, (c) =>
        c.query(`UPDATE properties SET currency = 'USD' WHERE id = $1`, [ids.propA2]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await inTenant(ids.orgA, (c) =>
      c.query(`UPDATE properties SET currency = 'USD' WHERE id = $1`, [ids.propEmpty]),
    );
  });
});

describe('concurrency', () => {
  it('gives two concurrent postings distinct consecutive numbers', async () => {
    const [a, b] = await Promise.all([
      inTenant(ids.orgA, async (c) =>
        Number((await post(c, await balancedDraft(c, 10))).rows[0].entry_number),
      ),
      inTenant(ids.orgA, async (c) =>
        Number((await post(c, await balancedDraft(c, 20))).rows[0].entry_number),
      ),
    ]);
    expect(Math.abs(a - b)).toBe(1);
  });

  it('does not let a period close while an entry is being posted into it', async () => {
    const posting = await openTenantTransaction(ids.orgA);
    const closer = await openTenantTransaction(ids.orgA);
    try {
      await post(posting, await balancedDraft(posting, 30));
      await closer.query("SET LOCAL lock_timeout = '500ms'");
      await expect(
        closer.query(
          `UPDATE accounting_periods SET status = 'CLOSED', closed_at = now()
            WHERE property_id = $1 AND start_date = '2027-01-01'`,
          [ids.propA],
        ),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await closer.query('ROLLBACK').catch(() => undefined);
      await posting.query('ROLLBACK').catch(() => undefined);
      closer.release();
      posting.release();
    }
  });

  it('refuses a line added while its entry is being posted, once the posting commits', async () => {
    const entry = await inTenant(ids.orgA, (c) => balancedDraft(c, 40));
    const posting = await openTenantTransaction(ids.orgA);
    const adder = await openTenantTransaction(ids.orgA);
    try {
      await post(posting, entry);
      const added = line(adder, entry, { n: 3, account: acctOf(ids.propA).bank, debit: 1 });
      // The line waits for the posting transaction to finish.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await posting.query('COMMIT');
      await expect(added).rejects.toMatchObject({ code: '42501' });
    } finally {
      await adder.query('ROLLBACK').catch(() => undefined);
      await posting.query('ROLLBACK').catch(() => undefined);
      adder.release();
      posting.release();
    }
  });
});

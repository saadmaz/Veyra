import { DomainError } from '@veyra/domain';
import { describe, expect, it, vi } from 'vitest';
import {
  type SqlExecutor,
  type TransactionRunner,
  withTenantTransaction,
  withUserTransaction,
} from '../src/tenant-transaction';

const USER = '0192f0a4-7c1e-7b2a-9c4d-aaaaaaaaaaaa';

const ORG = '0192f0a4-7c1e-7b2a-9c4d-1a2b3c4d5e6f';

function fakeClient() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx: SqlExecutor = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?'), values });
      return 1;
    }),
  };
  // A real generic method (vi.fn would erase the <R> type parameter), observed with a spy.
  const client: TransactionRunner<SqlExecutor> = {
    async $transaction<R>(fn: (t: SqlExecutor) => Promise<R>): Promise<R> {
      return fn(tx);
    },
  };
  const transaction = vi.spyOn(client, '$transaction');
  return { client, transaction, tx, calls };
}

describe('withTenantTransaction', () => {
  it('sets app.organisation_id as a bound parameter before running work', async () => {
    const { client, transaction, calls } = fakeClient();
    const order: string[] = [];

    const result = await withTenantTransaction(client, { organisationId: ORG }, async () => {
      order.push(`work after ${calls.length} statements`);
      return 'done';
    });

    expect(result).toBe('done');
    expect(transaction).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe("SELECT set_config('app.organisation_id', ?, true)");
    expect(calls[0]?.values).toEqual([ORG]);
    expect(order).toEqual(['work after 1 statements']);
  });

  it('refuses to start a transaction without a valid tenant', async () => {
    const { client, transaction } = fakeClient();
    await expect(
      withTenantTransaction(client, { organisationId: 'not-a-uuid' }, async () => 'x'),
    ).rejects.toBeInstanceOf(DomainError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('also sets app.user_id when the acting user is known', async () => {
    const { client, calls } = fakeClient();
    await withTenantTransaction(client, { organisationId: ORG }, async () => null, {
      userId: USER,
    });
    expect(calls.map((c) => c.values)).toEqual([[ORG], [USER]]);
    expect(calls[1]?.sql).toBe("SELECT set_config('app.user_id', ?, true)");
  });

  it('rejects a malformed user id before starting a transaction', async () => {
    const { client, transaction } = fakeClient();
    await expect(
      withTenantTransaction(client, { organisationId: ORG }, async () => null, {
        userId: 'x',
      }),
    ).rejects.toBeInstanceOf(DomainError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('propagates failures from work so the transaction rolls back', async () => {
    const { client } = fakeClient();
    await expect(
      withTenantTransaction(client, { organisationId: ORG }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('withUserTransaction', () => {
  it('sets only app.user_id', async () => {
    const { client, calls } = fakeClient();
    await withUserTransaction(client, USER, async () => null);
    expect(calls).toEqual([{ sql: "SELECT set_config('app.user_id', ?, true)", values: [USER] }]);
  });

  it('rejects a malformed user id', async () => {
    const { client, transaction } = fakeClient();
    await expect(withUserTransaction(client, 'nope', async () => null)).rejects.toBeInstanceOf(
      DomainError,
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});

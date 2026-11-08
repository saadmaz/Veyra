import { DomainError } from '@veyra/domain';
import { describe, expect, it, vi } from 'vitest';
import { type SqlExecutor, withTenantTransaction } from '../src/tenant-transaction';

const ORG = '0192f0a4-7c1e-7b2a-9c4d-1a2b3c4d5e6f';

function fakeClient() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx: SqlExecutor = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join('?'), values });
      return 1;
    }),
  };
  const client = {
    $transaction: vi.fn(async <R>(fn: (t: SqlExecutor) => Promise<R>) => fn(tx)),
  };
  return { client, tx, calls };
}

describe('withTenantTransaction', () => {
  it('sets app.organisation_id as a bound parameter before running work', async () => {
    const { client, calls } = fakeClient();
    const order: string[] = [];

    const result = await withTenantTransaction(client, { organisationId: ORG }, async () => {
      order.push(`work after ${calls.length} statements`);
      return 'done';
    });

    expect(result).toBe('done');
    expect(client.$transaction).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe("SELECT set_config('app.organisation_id', ?, true)");
    expect(calls[0]?.values).toEqual([ORG]);
    expect(order).toEqual(['work after 1 statements']);
  });

  it('refuses to start a transaction without a valid tenant', async () => {
    const { client } = fakeClient();
    await expect(
      withTenantTransaction(client, { organisationId: 'not-a-uuid' }, async () => 'x'),
    ).rejects.toBeInstanceOf(DomainError);
    expect(client.$transaction).not.toHaveBeenCalled();
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

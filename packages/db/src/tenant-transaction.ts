import { assertTenantContext, type TenantContext } from '@veyra/domain';

/**
 * Minimal transaction client surface needed here. Matches Prisma's interactive transaction
 * client without depending on generated model types.
 */
export interface SqlExecutor {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface TransactionRunner<TTx extends SqlExecutor> {
  $transaction<R>(fn: (tx: TTx) => Promise<R>): Promise<R>;
}

/**
 * Runs `work` in a transaction with the PostgreSQL setting `app.organisation_id` applied via
 * `set_config(..., true)` (equivalent to SET LOCAL, scoped to this transaction only).
 * Row-Level Security policies read this setting (docs/architecture/MULTI_TENANCY.md).
 *
 * All tenant-owned data access must go through this helper so the setting cannot be forgotten.
 */
export async function withTenantTransaction<TTx extends SqlExecutor, R>(
  client: TransactionRunner<TTx>,
  tenant: TenantContext,
  work: (tx: TTx) => Promise<R>,
): Promise<R> {
  const { organisationId } = assertTenantContext(tenant);
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.organisation_id', ${organisationId}, true)`;
    return work(tx);
  });
}

import { assertTenantContext, DomainError, type TenantContext } from '@veyra/domain';

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUserId(userId: string): string {
  if (!UUID_PATTERN.test(userId)) {
    throw new DomainError('USER_CONTEXT_REQUIRED', 'Operation requires a valid user id');
  }
  return userId;
}

/**
 * Runs `work` in a transaction scoped to one organisation. Sets the PostgreSQL settings read by
 * the row-level security policies (docs/architecture/MULTI_TENANCY.md):
 *   app.organisation_id  always
 *   app.user_id          when the acting user is known
 * set_config(..., true) is transaction-local (like SET LOCAL), so pooled connections never leak
 * context between requests. All tenant-owned data access must go through this helper.
 */
export async function withTenantTransaction<TTx extends SqlExecutor, R>(
  client: TransactionRunner<TTx>,
  tenant: TenantContext,
  work: (tx: TTx) => Promise<R>,
  options: { userId?: string } = {},
): Promise<R> {
  const { organisationId } = assertTenantContext(tenant);
  const userId = options.userId === undefined ? undefined : assertUserId(options.userId);
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.organisation_id', ${organisationId}, true)`;
    if (userId) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    }
    return work(tx);
  });
}

/**
 * Runs `work` in a transaction that knows the acting user but no organisation. RLS then only
 * exposes the user's own memberships and the organisations they belong to: used for
 * "list my organisations" before a tenant is chosen.
 */
export async function withUserTransaction<TTx extends SqlExecutor, R>(
  client: TransactionRunner<TTx>,
  userId: string,
  work: (tx: TTx) => Promise<R>,
): Promise<R> {
  const id = assertUserId(userId);
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${id}, true)`;
    return work(tx);
  });
}

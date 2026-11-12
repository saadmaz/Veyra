import { type DbClient, withTenantTransaction } from '@veyra/db';
import { DomainError, type JobEnvelope } from '@veyra/domain';

/** Outbox event type written by the database when a maintenance due time is set (Phase 7). */
export const SLA_DUE_EVENT = 'maintenance.sla.due';
export const SLA_CHECK_JOB = 'maintenance.sla.check';

export interface SlaDuePayload {
  requestId: string;
  propertyId: string;
  target: 'RESPONSE' | 'RESOLUTION';
  /** ISO 8601, as written by the database. */
  dueAt: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parsePayload(payload: unknown): SlaDuePayload {
  const p = payload as Partial<SlaDuePayload> | null;
  if (
    !p ||
    typeof p.requestId !== 'string' ||
    !UUID.test(p.requestId) ||
    (p.target !== 'RESPONSE' && p.target !== 'RESOLUTION') ||
    typeof p.dueAt !== 'string' ||
    Number.isNaN(Date.parse(p.dueAt))
  ) {
    throw new DomainError('INVALID_JOB_PAYLOAD', `Invalid ${SLA_CHECK_JOB} payload`);
  }
  return p as SlaDuePayload;
}

/**
 * When a response or resolution target falls due, records the breach if it was missed. The
 * database decides (app_maintenance_check_breach, in the tenant's context): a met, moved or
 * already recorded target is a no-op, so retries and duplicates are harmless. A job that runs a
 * little early (clock skew) does nothing; the outbox relays it once due.
 */
export function checkSlaBreach(db: DbClient) {
  return async (envelope: JobEnvelope<unknown>) => {
    const tenant = envelope.tenant;
    if (!tenant) throw new DomainError('TENANT_CONTEXT_REQUIRED', 'SLA checks run per tenant');
    const payload = parsePayload(envelope.payload);
    const breached = await withTenantTransaction(db, tenant, async (tx) => {
      const rows = await tx.$queryRaw<{ hit: boolean }[]>`
        SELECT app_maintenance_check_breach(${payload.requestId}::uuid, ${payload.target},
                                            ${payload.dueAt}::timestamptz) AS "hit"`;
      return rows[0]?.hit === true;
    });
    return { breached };
  };
}

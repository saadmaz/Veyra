import { type DbClient, withTenantTransaction } from '@veyra/db';
import { DomainError, type JobEnvelope, type TenantContext } from '@veyra/domain';

/** Outbox event type written by the database for each new delivery (Phase 10). */
export const DELIVERY_DUE_EVENT = 'notification.delivery.due';
export const DELIVER_JOB = 'notification.deliver';
/** Matches the queue's attempts: the last failure marks the delivery FAILED. */
export const MAX_ATTEMPTS = 5;

/** Sends one email. Implementations never log addresses or content. */
export interface EmailSender {
  readonly name: string;
  send(message: { deliveryId: string; to: string; subject: string; text: string }): Promise<{
    reference: string;
  }>;
}

/** Development and test adapter: accepts everything and logs only the delivery id. */
export class LogEmailSender implements EmailSender {
  readonly name = 'log';
  constructor(private readonly log: (line: string) => void = console.log) {}
  async send(message: { deliveryId: string }) {
    this.log(`[email:log] delivery ${message.deliveryId} accepted`);
    return { reference: `log-${message.deliveryId}` };
  }
}

export interface PendingDelivery {
  id: string;
  channel: 'EMAIL' | 'SMS' | 'PUSH';
  status: 'PENDING' | 'SENT' | 'FAILED';
  to: string | null;
  subject: string;
  text: string;
}

/** What the delivery job needs from the database, in the tenant's context. */
export interface DeliveryStore {
  load(tenant: TenantContext, deliveryId: string): Promise<PendingDelivery | null>;
  record(
    tenant: TenantContext,
    deliveryId: string,
    outcome: { sent: true; reference: string } | { sent: false; error: string },
  ): Promise<'PENDING' | 'SENT' | 'FAILED'>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sends one delivery and records the attempt. A delivery that is no longer pending is skipped,
 * so duplicates are harmless. A failed attempt is recorded, then thrown so the queue retries it
 * (with backoff) until the last attempt marks it FAILED.
 */
export function deliverNotification(store: DeliveryStore, email: EmailSender) {
  return async (envelope: JobEnvelope<unknown>) => {
    const tenant = envelope.tenant;
    if (!tenant) throw new DomainError('TENANT_CONTEXT_REQUIRED', 'Deliveries run per tenant');
    const deliveryId = (envelope.payload as { deliveryId?: unknown } | null)?.deliveryId;
    if (typeof deliveryId !== 'string' || !UUID.test(deliveryId)) {
      throw new DomainError('INVALID_JOB_PAYLOAD', `Invalid ${DELIVER_JOB} payload`);
    }
    const delivery = await store.load(tenant, deliveryId);
    if (delivery?.status !== 'PENDING') return { skipped: true };
    let outcome: { sent: true; reference: string } | { sent: false; error: string };
    if (delivery.channel !== 'EMAIL' || !delivery.to) {
      outcome = { sent: false, error: `No ${delivery.channel.toLowerCase()} address or adapter` };
    } else {
      try {
        const { reference } = await email.send({
          deliveryId,
          to: delivery.to,
          subject: delivery.subject,
          text: delivery.text,
        });
        outcome = { sent: true, reference };
      } catch (error) {
        outcome = { sent: false, error: error instanceof Error ? error.message : 'Send failed' };
      }
    }
    const status = await store.record(tenant, deliveryId, outcome);
    if (status === 'PENDING') {
      throw new Error(`Delivery ${deliveryId} failed; will retry`);
    }
    return { status };
  };
}

/** The delivery store over the application database role, under row-level security. */
export function prismaDeliveryStore(db: DbClient): DeliveryStore {
  return {
    load: (tenant, deliveryId) =>
      withTenantTransaction(db, tenant, async (tx) => {
        const row = await tx.notificationDelivery.findFirst({
          where: { id: deliveryId, organisationId: tenant.organisationId },
          select: {
            id: true,
            channel: true,
            status: true,
            notification: {
              select: { title: true, body: true, user: { select: { email: true } } },
            },
          },
        });
        if (!row) return null;
        return {
          id: row.id,
          channel: row.channel,
          status: row.status,
          to: row.notification.user.email,
          subject: row.notification.title,
          text: row.notification.body,
        };
      }),
    record: (tenant, deliveryId, outcome) =>
      withTenantTransaction(db, tenant, async (tx) => {
        const rows = await tx.$queryRaw<{ status: 'PENDING' | 'SENT' | 'FAILED' }[]>`
          SELECT app_notification_delivery_result(
            ${deliveryId}::uuid, ${outcome.sent}, ${outcome.sent ? outcome.reference : null},
            ${outcome.sent ? null : outcome.error}, ${MAX_ATTEMPTS})::text AS status`;
        return rows[0]?.status ?? 'PENDING';
      }),
  };
}

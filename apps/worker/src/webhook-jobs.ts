import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { type DbClient, signWebhook, webhookSecret, withTenantTransaction } from '@veyra/db';
import { DomainError, type JobEnvelope, type TenantContext } from '@veyra/domain';

/** Outbox event type written by the database for each new webhook delivery (Phase 12). */
export const WEBHOOK_DUE_EVENT = 'webhook.delivery.due';
export const WEBHOOK_JOB = 'webhook.deliver';
/** Matches the queue's attempts: the last failure marks the delivery FAILED. */
export const WEBHOOK_MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 10_000;

export interface PendingWebhook {
  id: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  eventType: string;
  payload: unknown;
  endpoint: { id: string; url: string; status: 'ACTIVE' | 'DISABLED'; secretVersion: number };
}

export type WebhookOutcome =
  | { succeeded: true; statusCode: number }
  | { succeeded: false; statusCode: number | null; error: string };

export interface WebhookStore {
  load(tenant: TenantContext, deliveryId: string): Promise<PendingWebhook | null>;
  record(
    tenant: TenantContext,
    deliveryId: string,
    outcome: WebhookOutcome,
  ): Promise<'PENDING' | 'SUCCEEDED' | 'FAILED'>;
}

/** Sends one HTTP request. Implementations never log bodies or secrets. */
export interface WebhookSender {
  post(url: string, headers: Record<string, string>, body: string): Promise<{ status: number }>;
}

/** True for addresses a webhook must never reach (loopback, private, link-local, ...). */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    v6.startsWith('fe80') ||
    v6.startsWith('ff')
  );
}

/**
 * Production sender: resolves the host and refuses private addresses (so a public name pointed
 * at an internal address is not reached), does not follow redirects, and gives up after ten
 * seconds. Any 2xx counts as delivered.
 */
export class FetchWebhookSender implements WebhookSender {
  constructor(
    private readonly resolve: (host: string) => Promise<string[]> = async (host) =>
      (await lookup(host, { all: true })).map((r) => r.address),
  ) {}

  async post(url: string, headers: Record<string, string>, body: string) {
    const { hostname } = new URL(url);
    const addresses = await this.resolve(hostname);
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw new Error('The endpoint resolves to a private address');
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sends one webhook delivery, signed, and records the attempt. Deliveries no longer pending are
 * skipped (duplicates are harmless); a disabled endpoint or a missing key fails the attempt; a
 * failed attempt is thrown so the queue retries it until the last attempt marks it FAILED.
 */
export function deliverWebhook(
  store: WebhookStore,
  sender: WebhookSender,
  key: Buffer | null,
  now: () => number = () => Math.floor(Date.now() / 1000),
) {
  return async (envelope: JobEnvelope<unknown>) => {
    const tenant = envelope.tenant;
    if (!tenant) throw new DomainError('TENANT_CONTEXT_REQUIRED', 'Webhooks run per tenant');
    const deliveryId = (envelope.payload as { deliveryId?: unknown } | null)?.deliveryId;
    if (typeof deliveryId !== 'string' || !UUID.test(deliveryId)) {
      throw new DomainError('INVALID_JOB_PAYLOAD', `Invalid ${WEBHOOK_JOB} payload`);
    }
    const delivery = await store.load(tenant, deliveryId);
    if (delivery?.status !== 'PENDING') return { skipped: true };

    let outcome: WebhookOutcome;
    if (!key) {
      outcome = { succeeded: false, statusCode: null, error: 'Webhooks are not set up' };
    } else if (delivery.endpoint.status !== 'ACTIVE') {
      outcome = { succeeded: false, statusCode: null, error: 'The endpoint is disabled' };
    } else {
      const body = JSON.stringify(delivery.payload);
      const secret = webhookSecret(key, delivery.endpoint.id, delivery.endpoint.secretVersion);
      try {
        const { status } = await sender.post(
          delivery.endpoint.url,
          {
            'content-type': 'application/json',
            'user-agent': 'VEYRA-Webhooks/1',
            'veyra-event': delivery.eventType,
            'veyra-delivery': delivery.id,
            'veyra-signature': signWebhook(secret, now(), body),
          },
          body,
        );
        outcome =
          status >= 200 && status < 300
            ? { succeeded: true, statusCode: status }
            : { succeeded: false, statusCode: status, error: `The endpoint answered ${status}` };
      } catch (error) {
        outcome = {
          succeeded: false,
          statusCode: null,
          error: error instanceof Error ? error.message : 'Send failed',
        };
      }
    }
    const status = await store.record(tenant, deliveryId, outcome);
    if (status === 'PENDING') throw new Error(`Webhook ${deliveryId} failed; will retry`);
    return { status };
  };
}

/** The webhook store over the application database role, under row-level security. */
export function prismaWebhookStore(db: DbClient): WebhookStore {
  return {
    load: (tenant, deliveryId) =>
      withTenantTransaction(db, tenant, async (tx) => {
        const row = await tx.webhookDelivery.findFirst({
          where: { id: deliveryId, organisationId: tenant.organisationId },
          select: {
            id: true,
            status: true,
            eventType: true,
            payload: true,
            endpoint: { select: { id: true, url: true, status: true, secretVersion: true } },
          },
        });
        return row ?? null;
      }),
    record: (tenant, deliveryId, outcome) =>
      withTenantTransaction(db, tenant, async (tx) => {
        const rows = await tx.$queryRaw<{ status: 'PENDING' | 'SUCCEEDED' | 'FAILED' }[]>`
          SELECT app_webhook_delivery_result(
            ${deliveryId}::uuid, ${outcome.succeeded}, ${outcome.statusCode},
            ${outcome.succeeded ? null : outcome.error}, ${WEBHOOK_MAX_ATTEMPTS})::text AS status`;
        return rows[0]?.status ?? 'PENDING';
      }),
  };
}

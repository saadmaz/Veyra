import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, type DbTransaction, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import type { TransactionHandle } from '../../../platform/transaction-handle';
import type { WebhookRepository, WebhookUnitOfWork } from '../application/webhook-ports';

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

const ENDPOINT = {
  id: true,
  url: true,
  description: true,
  events: true,
  status: true,
  secretVersion: true,
  createdAt: true,
} as const;

async function queue(
  tx: DbTransaction,
  organisationId: string,
  endpointIds: string[],
  event: { id: string; type: string; payload: unknown },
) {
  await tx.webhookDelivery.createMany({
    data: endpointIds.map((endpointId) => ({
      organisationId,
      endpointId,
      eventType: event.type,
      eventId: event.id,
      // Plain JSON only (no undefined, dates as strings).
      payload: JSON.parse(JSON.stringify(event.payload)),
    })),
  });
}

class PrismaWebhookUnitOfWork implements WebhookUnitOfWork {
  constructor(
    private readonly tx: DbTransaction,
    private readonly organisationId: string,
    private readonly userId: string,
    private readonly meta: RequestMeta,
  ) {}

  endpoints() {
    return this.tx.webhookEndpoint.findMany({
      where: { organisationId: this.organisationId },
      select: ENDPOINT,
      orderBy: { createdAt: 'asc' },
    });
  }

  endpoint(id: string) {
    return this.tx.webhookEndpoint.findFirst({
      where: { organisationId: this.organisationId, id },
      select: ENDPOINT,
    });
  }

  async createEndpoint(input: { url: string; description: string | null; events: string[] }) {
    const row = await this.tx.webhookEndpoint.create({
      data: { organisationId: this.organisationId, ...input, createdByUserId: this.userId },
      select: { id: true },
    });
    return row.id;
  }

  async updateEndpoint(id: string, patch: Parameters<WebhookUnitOfWork['updateEndpoint']>[1]) {
    await this.tx.webhookEndpoint.updateMany({
      where: { organisationId: this.organisationId, id },
      data: patch,
    });
  }

  deliveries(endpointId: string, limit: number) {
    return this.tx.webhookDelivery.findMany({
      where: { organisationId: this.organisationId, endpointId },
      select: {
        id: true,
        eventType: true,
        eventId: true,
        status: true,
        attempts: true,
        lastStatusCode: true,
        lastError: true,
        deliveredAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  queue(endpointIds: string[], event: { id: string; type: string; payload: unknown }) {
    return queue(this.tx, this.organisationId, endpointIds, event);
  }

  async audit(event: Parameters<WebhookUnitOfWork['audit']>[0]) {
    await this.tx.auditLog.createMany({
      data: [
        {
          organisationId: this.organisationId,
          actorUserId: this.userId,
          action: event.action,
          resourceType: 'webhook_endpoint',
          resourceId: event.resourceId,
          metadata: event.metadata ?? {},
          requestId: clip(this.meta.requestId, 128),
          ipAddress: clip(this.meta.ipAddress, 64),
        },
      ],
    });
  }
}

/** Webhook persistence over Prisma, always inside the organisation's RLS context. */
@Injectable()
export class PrismaWebhookRepository implements WebhookRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inOrganisation<T>(
    organisationId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: WebhookUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaWebhookUnitOfWork(tx, organisationId, userId, meta)),
      { userId },
    );
  }

  async subscribersWithin(transaction: TransactionHandle, organisationId: string, type: string) {
    const tx = transaction as unknown as DbTransaction;
    const rows = await tx.webhookEndpoint.findMany({
      where: { organisationId, status: 'ACTIVE', events: { has: type } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  queueWithin(
    transaction: TransactionHandle,
    organisationId: string,
    endpointIds: string[],
    event: { id: string; type: string; payload: unknown },
  ) {
    return queue(transaction as unknown as DbTransaction, organisationId, endpointIds, event);
  }
}

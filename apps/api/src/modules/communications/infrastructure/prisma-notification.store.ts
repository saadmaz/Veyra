import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, type DbTransaction, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import type { TransactionHandle } from '../../../platform/transaction-handle';
import type {
  DeliveryRecord,
  NewNotification,
  NotificationRecord,
  NotificationStore,
} from '../application/notification-ports';

/** Notifications over Prisma, always inside the organisation's RLS context. */
@Injectable()
export class PrismaNotificationStore implements NotificationStore {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async createWithin(
    transaction: TransactionHandle,
    organisationId: string,
    items: readonly NewNotification[],
  ) {
    const tx = transaction as unknown as DbTransaction;
    for (const item of items) {
      const { id } = await tx.notification.create({
        data: {
          organisationId,
          propertyId: item.propertyId,
          userId: item.userId,
          kind: item.kind,
          title: item.title,
          body: item.body,
          link: item.link,
          urgent: item.urgent,
        },
        select: { id: true },
      });
      if (item.email) {
        await tx.notificationDelivery.create({
          data: { organisationId, notificationId: id, channel: 'EMAIL' },
        });
      }
    }
  }

  feed(
    organisationId: string,
    userId: string,
    _meta: RequestMeta,
    limit: number,
  ): Promise<NotificationRecord[]> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) =>
        tx.notification.findMany({
          where: { organisationId, userId },
          select: {
            id: true,
            propertyId: true,
            kind: true,
            title: true,
            body: true,
            link: true,
            urgent: true,
            createdAt: true,
            readAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
      { userId },
    );
  }

  markRead(organisationId: string, userId: string, id: string | null) {
    return withTenantTransaction(
      this.db,
      { organisationId },
      async (tx) => {
        const { count } = await tx.notification.updateMany({
          where: { organisationId, userId, readAt: null, ...(id ? { id } : {}) },
          data: { readAt: new Date() },
        });
        return count;
      },
      { userId },
    );
  }

  deliveries(
    organisationId: string,
    userId: string,
    propertyId: string,
    status: DeliveryRecord['status'] | undefined,
  ): Promise<DeliveryRecord[]> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      async (tx) => {
        const rows = await tx.notificationDelivery.findMany({
          where: { organisationId, notification: { propertyId }, ...(status ? { status } : {}) },
          select: {
            id: true,
            channel: true,
            status: true,
            attempts: true,
            lastError: true,
            sentAt: true,
            createdAt: true,
            notification: {
              select: { kind: true, title: true, user: { select: { displayName: true } } },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 200,
        });
        return rows.map(({ notification, ...r }) => ({
          ...r,
          notification: {
            kind: notification.kind,
            title: notification.title,
            recipientName: notification.user.displayName,
          },
        }));
      },
      { userId },
    );
  }
}

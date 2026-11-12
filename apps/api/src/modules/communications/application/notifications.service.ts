import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import type { TransactionHandle } from '../../../platform/transaction-handle';
import {
  type NewNotification,
  NOTIFICATION_STORE,
  type NotificationStore,
} from './notification-ports';

/**
 * Notifications (Phase 10 Part 2). Other modules tell people about what happened through
 * `notifyWithin`, on their own open transaction, so a notification exists exactly when the change
 * it describes does. Every notification shows in the person's in-app feed; email deliveries are
 * sent by the worker through a provider adapter, retried, and their outcome recorded.
 */
@Injectable()
export class NotificationsService {
  constructor(@Inject(NOTIFICATION_STORE) private readonly store: NotificationStore) {}

  notifyWithin(
    transaction: TransactionHandle,
    organisationId: string,
    items: readonly NewNotification[],
  ) {
    const unique = new Map<string, NewNotification>();
    for (const item of items) unique.set(item.userId, item);
    return this.store.createWithin(transaction, organisationId, [...unique.values()]);
  }

  feed(organisationId: string, userId: string, meta: RequestMeta) {
    return this.store.feed(organisationId, userId, meta, 100);
  }

  async markRead(organisationId: string, userId: string, id: string) {
    const changed = await this.store.markRead(organisationId, userId, id);
    if (changed === 0) {
      const mine = (await this.store.feed(organisationId, userId, {} as RequestMeta, 100)).some(
        (n) => n.id === id,
      );
      if (!mine) throw new ApiError(404, 'NOT_FOUND', 'Notification not found');
    }
  }

  markAllRead(organisationId: string, userId: string) {
    return this.store.markRead(organisationId, userId, null);
  }

  deliveries(
    organisationId: string,
    userId: string,
    propertyId: string,
    status: 'PENDING' | 'SENT' | 'FAILED' | undefined,
  ) {
    return this.store.deliveries(organisationId, userId, propertyId, status);
  }
}

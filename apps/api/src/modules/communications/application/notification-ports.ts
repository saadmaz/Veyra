import type { RequestMeta } from '../../../platform/request-meta';
import type { TransactionHandle } from '../../../platform/transaction-handle';

/** Something to tell one person. */
export interface NewNotification {
  userId: string;
  propertyId: string | null;
  /** What happened, e.g. "facility.booking.approved" (lower case, dots). */
  kind: string;
  title: string;
  body: string;
  /** A console path to open. */
  link: string | null;
  urgent: boolean;
  /** Also send by email (in-app always). */
  email: boolean;
}

export interface NotificationRecord {
  id: string;
  propertyId: string | null;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  urgent: boolean;
  createdAt: Date;
  readAt: Date | null;
}

export interface DeliveryRecord {
  id: string;
  channel: 'EMAIL' | 'SMS' | 'PUSH';
  status: 'PENDING' | 'SENT' | 'FAILED';
  attempts: number;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;
  notification: { kind: string; title: string; recipientName: string };
}

export interface NotificationStore {
  /** Writes notifications (and email deliveries) on the caller's open transaction. */
  createWithin(
    transaction: TransactionHandle,
    organisationId: string,
    items: readonly NewNotification[],
  ): Promise<void>;
  feed(
    organisationId: string,
    userId: string,
    meta: RequestMeta,
    limit: number,
  ): Promise<NotificationRecord[]>;
  markRead(organisationId: string, userId: string, id: string | null): Promise<number>;
  deliveries(
    organisationId: string,
    userId: string,
    propertyId: string,
    status: DeliveryRecord['status'] | undefined,
  ): Promise<DeliveryRecord[]>;
}

export const NOTIFICATION_STORE = Symbol('NOTIFICATION_STORE');

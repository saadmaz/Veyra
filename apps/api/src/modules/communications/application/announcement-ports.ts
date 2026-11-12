import type { RequestMeta } from '../../../platform/request-meta';
import type { TransactionHandle } from '../../../platform/transaction-handle';
import type { AnnouncementStatus, Audience, Priority } from '../domain/announcement-rules';

export interface AnnouncementContent {
  title: string;
  body: string;
  priority: Priority;
  audience: Audience;
  buildingId: string | null;
  requiresAcknowledgement: boolean;
}

export interface AnnouncementRecord extends AnnouncementContent {
  id: string;
  propertyId: string;
  propertyName: string;
  buildingName: string | null;
  status: AnnouncementStatus;
  publishedAt: Date | null;
  publishedByName: string | null;
  withdrawnAt: Date | null;
  withdrawReason: string | null;
  createdByName: string;
  createdAt: Date;
  /** Delivery figures (published announcements). */
  recipients: number;
  read: number;
  acknowledged: number;
}

export interface InboxRecord {
  announcement: AnnouncementRecord;
  readAt: Date | null;
  acknowledgedAt: Date | null;
}

export interface RecipientRecord {
  userId: string;
  name: string;
  readAt: Date | null;
  acknowledgedAt: Date | null;
}

/** One transaction in the organisation's RLS context (property-scoped work names the property). */
export interface AnnouncementUnitOfWork {
  /** The open transaction, for notifications written in the same commit. */
  transaction(): TransactionHandle;
  building(
    propertyId: string,
    id: string,
  ): Promise<{ id: string; status: 'ACTIVE' | 'ARCHIVED' } | null>;
  announcements(
    propertyId: string,
    status: AnnouncementStatus | undefined,
  ): Promise<AnnouncementRecord[]>;
  announcement(propertyId: string, id: string): Promise<AnnouncementRecord | null>;
  createDraft(propertyId: string, input: AnnouncementContent): Promise<string>;
  updateDraft(propertyId: string, id: string, patch: Partial<AnnouncementContent>): Promise<void>;
  setStatus(
    propertyId: string,
    id: string,
    status: 'PUBLISHED' | 'WITHDRAWN',
    reason: string | null,
  ): Promise<void>;
  /** Users living at the property (or building) today with a login. */
  residentUsers(propertyId: string, buildingId: string | null): Promise<string[]>;
  deliver(propertyId: string, announcementId: string, userIds: readonly string[]): Promise<number>;
  recipients(announcementId: string): Promise<RecipientRecord[]>;
  /** The caller's copies of published announcements of the organisation, newest first. */
  inbox(userId: string, limit: number): Promise<InboxRecord[]>;
  inboxItem(userId: string, announcementId: string): Promise<InboxRecord | null>;
  markRead(userId: string, announcementId: string): Promise<void>;
  acknowledge(userId: string, announcementId: string): Promise<void>;
  audit(event: {
    action: string;
    propertyId: string;
    resourceId: string;
    metadata?: Record<string, string | number | boolean>;
  }): Promise<void>;
}

export interface AnnouncementRepository {
  inOrganisation<T>(
    organisationId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: AnnouncementUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export const ANNOUNCEMENT_REPOSITORY = Symbol('ANNOUNCEMENT_REPOSITORY');

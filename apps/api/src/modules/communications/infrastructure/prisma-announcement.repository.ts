import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, type DbTransaction, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import type {
  AnnouncementContent,
  AnnouncementRecord,
  AnnouncementRepository,
  AnnouncementUnitOfWork,
  InboxRecord,
} from '../application/announcement-ports';
import type { AnnouncementStatus } from '../domain/announcement-rules';

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

const SELECT = {
  id: true,
  propertyId: true,
  title: true,
  body: true,
  priority: true,
  audience: true,
  buildingId: true,
  requiresAcknowledgement: true,
  status: true,
  publishedAt: true,
  withdrawnAt: true,
  withdrawReason: true,
  createdAt: true,
  property: { select: { name: true } },
  building: { select: { name: true } },
  publishedBy: { select: { displayName: true } },
  createdBy: { select: { displayName: true } },
  _count: { select: { recipients: true } },
} as const;

type Row = Omit<
  AnnouncementRecord,
  | 'propertyName'
  | 'buildingName'
  | 'publishedByName'
  | 'createdByName'
  | 'recipients'
  | 'read'
  | 'acknowledged'
> & {
  property: { name: string };
  building: { name: string } | null;
  publishedBy: { displayName: string } | null;
  createdBy: { displayName: string };
  _count: { recipients: number };
};

class PrismaAnnouncementUnitOfWork implements AnnouncementUnitOfWork {
  constructor(
    private readonly tx: DbTransaction,
    private readonly organisationId: string,
    private readonly userId: string,
    private readonly meta: RequestMeta,
  ) {}

  private async withFigures(rows: Row[]): Promise<AnnouncementRecord[]> {
    const ids = rows.map((r) => r.id);
    const figures = new Map<string, { read: number; acknowledged: number }>();
    if (ids.length > 0) {
      const counts = await this.tx.$queryRaw<{ id: string; read: number; acknowledged: number }[]>`
        SELECT "announcement_id"::text AS id, count("read_at")::int AS read, count("acknowledged_at")::int AS acknowledged
          FROM "announcement_recipients"
         WHERE "organisation_id" = ${this.organisationId}::uuid AND "announcement_id" = ANY(${ids}::uuid[])
         GROUP BY "announcement_id"`;
      for (const c of counts) figures.set(c.id, { read: c.read, acknowledged: c.acknowledged });
    }
    return rows.map(({ property, building, publishedBy, createdBy, _count, ...r }) => ({
      ...r,
      propertyName: property.name,
      buildingName: building?.name ?? null,
      publishedByName: publishedBy?.displayName ?? null,
      createdByName: createdBy.displayName,
      recipients: _count.recipients,
      read: figures.get(r.id)?.read ?? 0,
      acknowledged: figures.get(r.id)?.acknowledged ?? 0,
    }));
  }

  building(propertyId: string, id: string) {
    return this.tx.building.findFirst({
      where: { organisationId: this.organisationId, propertyId, id },
      select: { id: true, status: true },
    });
  }

  async announcements(propertyId: string, status: AnnouncementStatus | undefined) {
    const rows = await this.tx.announcement.findMany({
      where: { organisationId: this.organisationId, propertyId, ...(status ? { status } : {}) },
      select: SELECT,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return this.withFigures(rows);
  }

  async announcement(propertyId: string, id: string) {
    const row = await this.tx.announcement.findFirst({
      where: { organisationId: this.organisationId, propertyId, id },
      select: SELECT,
    });
    return row ? ((await this.withFigures([row]))[0] ?? null) : null;
  }

  async createDraft(propertyId: string, input: AnnouncementContent) {
    const { id } = await this.tx.announcement.create({
      data: {
        organisationId: this.organisationId,
        propertyId,
        ...input,
        createdByUserId: this.userId,
      },
      select: { id: true },
    });
    return id;
  }

  async updateDraft(propertyId: string, id: string, patch: Partial<AnnouncementContent>) {
    await this.tx.announcement.updateMany({
      where: { organisationId: this.organisationId, propertyId, id },
      data: patch,
    });
  }

  async setStatus(
    propertyId: string,
    id: string,
    status: 'PUBLISHED' | 'WITHDRAWN',
    reason: string | null,
  ) {
    await this.tx.announcement.updateMany({
      where: { organisationId: this.organisationId, propertyId, id },
      data: { status, withdrawReason: reason },
    });
  }

  async residentUsers(propertyId: string, buildingId: string | null) {
    const rows = await this.tx.$queryRaw<{ user_id: string }[]>`
      SELECT "user_id"::text FROM app_property_resident_users(${propertyId}::uuid, ${buildingId}::uuid)`;
    return rows.map((r) => r.user_id);
  }

  async deliver(propertyId: string, announcementId: string, userIds: readonly string[]) {
    if (userIds.length === 0) return 0;
    const { count } = await this.tx.announcementRecipient.createMany({
      data: userIds.map((userId) => ({
        organisationId: this.organisationId,
        propertyId,
        announcementId,
        userId,
      })),
      skipDuplicates: true,
    });
    return count;
  }

  async recipients(announcementId: string) {
    const rows = await this.tx.announcementRecipient.findMany({
      where: { organisationId: this.organisationId, announcementId },
      select: {
        userId: true,
        readAt: true,
        acknowledgedAt: true,
        user: { select: { displayName: true } },
      },
      orderBy: { user: { displayName: 'asc' } },
    });
    return rows.map((r) => ({
      userId: r.userId,
      name: r.user.displayName,
      readAt: r.readAt,
      acknowledgedAt: r.acknowledgedAt,
    }));
  }

  private async inboxRows(
    userId: string,
    announcementId: string | null,
    limit: number,
  ): Promise<InboxRecord[]> {
    const rows = await this.tx.announcementRecipient.findMany({
      where: {
        organisationId: this.organisationId,
        userId,
        announcement: { status: 'PUBLISHED' },
        ...(announcementId ? { announcementId } : {}),
      },
      select: { readAt: true, acknowledgedAt: true, announcement: { select: SELECT } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const announcements = await this.withFigures(rows.map((r) => r.announcement));
    return rows.map((r, i) => ({
      announcement: announcements[i] as AnnouncementRecord,
      readAt: r.readAt,
      acknowledgedAt: r.acknowledgedAt,
    }));
  }

  inbox(userId: string, limit: number) {
    return this.inboxRows(userId, null, limit);
  }

  async inboxItem(userId: string, announcementId: string) {
    return (await this.inboxRows(userId, announcementId, 1))[0] ?? null;
  }

  async markRead(userId: string, announcementId: string) {
    await this.tx.announcementRecipient.updateMany({
      where: { organisationId: this.organisationId, userId, announcementId },
      data: { readAt: new Date() },
    });
  }

  async acknowledge(userId: string, announcementId: string) {
    await this.tx.announcementRecipient.updateMany({
      where: { organisationId: this.organisationId, userId, announcementId },
      data: { acknowledgedAt: new Date() },
    });
  }

  async audit(event: {
    action: string;
    propertyId: string;
    resourceId: string;
    metadata?: Record<string, string | number | boolean>;
  }) {
    await this.tx.auditLog.createMany({
      data: [
        {
          organisationId: this.organisationId,
          actorUserId: this.userId,
          action: event.action,
          resourceType: 'announcement',
          resourceId: event.resourceId,
          metadata: { propertyId: event.propertyId, ...(event.metadata ?? {}) },
          requestId: clip(this.meta.requestId, 128),
          ipAddress: clip(this.meta.ipAddress, 64),
        },
      ],
    });
  }
}

/** Announcement persistence over Prisma, always inside the organisation's RLS context. */
@Injectable()
export class PrismaAnnouncementRepository implements AnnouncementRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inOrganisation<T>(
    organisationId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: AnnouncementUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaAnnouncementUnitOfWork(tx, organisationId, userId, meta)),
      { userId },
    );
  }
}

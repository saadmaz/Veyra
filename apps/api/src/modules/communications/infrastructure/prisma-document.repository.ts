import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, type DbTransaction, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import type {
  DocumentDetails,
  DocumentRecord,
  DocumentRepository,
  DocumentUnitOfWork,
} from '../application/document-ports';
import type { DocumentAudience, DocumentCategory } from '../domain/document-rules';

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));
const asDate = (d: string | null | undefined) =>
  d === undefined ? undefined : d === null ? null : new Date(`${d}T00:00:00Z`);

const SELECT = {
  id: true,
  title: true,
  description: true,
  category: true,
  audience: true,
  expiresOn: true,
  status: true,
  archivedAt: true,
  createdAt: true,
  versions: {
    select: {
      id: true,
      versionNumber: true,
      storageKey: true,
      fileName: true,
      contentType: true,
      sizeBytes: true,
      note: true,
      status: true,
      createdAt: true,
      readyAt: true,
      uploadedBy: { select: { displayName: true } },
    },
    orderBy: { versionNumber: 'desc' as const },
  },
} as const;

type Row = {
  id: string;
  title: string;
  description: string | null;
  category: DocumentCategory;
  audience: DocumentAudience;
  expiresOn: Date | null;
  status: 'ACTIVE' | 'ARCHIVED';
  archivedAt: Date | null;
  createdAt: Date;
  versions: {
    id: string;
    versionNumber: number;
    storageKey: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    note: string | null;
    status: 'PENDING' | 'READY' | 'REJECTED';
    createdAt: Date;
    readyAt: Date | null;
    uploadedBy: { displayName: string };
  }[];
};

const toDocument = (row: Row): DocumentRecord => ({
  ...row,
  expiresOn: row.expiresOn ? row.expiresOn.toISOString().slice(0, 10) : null,
  versions: row.versions.map(({ uploadedBy, ...v }) => ({
    ...v,
    uploadedByName: uploadedBy.displayName,
  })),
});

class PrismaDocumentUnitOfWork implements DocumentUnitOfWork {
  private readonly scope: { organisationId: string; propertyId: string };

  constructor(
    private readonly tx: DbTransaction,
    private readonly organisationId: string,
    private readonly propertyId: string,
    private readonly userId: string,
    private readonly meta: RequestMeta,
  ) {
    this.scope = { organisationId, propertyId };
  }

  async today() {
    const rows = await this.tx.$queryRaw<{ today: string }[]>`
      SELECT to_char((now() AT TIME ZONE "time_zone")::date, 'YYYY-MM-DD') AS today
        FROM "properties" WHERE "id" = ${this.propertyId}::uuid AND "organisation_id" = ${this.organisationId}::uuid`;
    const today = rows[0]?.today;
    if (!today) throw new Error('Property vanished inside its own transaction');
    return today;
  }

  async callerOwns(unitId: string) {
    const rows = await this.tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app_resident_grants(${this.userId}::uuid) g
       WHERE g."role" = 'OWNER' AND g."unit_id" = ${unitId}::uuid AND g."property_id" = ${this.propertyId}::uuid`;
    return (rows[0]?.n ?? 0) > 0;
  }

  async documents(filter: { audiences: DocumentAudience[] | null; activeOnly: boolean }) {
    const rows = await this.tx.document.findMany({
      where: {
        ...this.scope,
        ...(filter.audiences ? { audience: { in: filter.audiences } } : {}),
        ...(filter.activeOnly ? { status: 'ACTIVE' as const } : {}),
      },
      select: SELECT,
      orderBy: [{ category: 'asc' }, { title: 'asc' }],
      take: 500,
    });
    return rows.map(toDocument);
  }

  async document(id: string) {
    const row = await this.tx.document.findFirst({ where: { ...this.scope, id }, select: SELECT });
    return row ? toDocument(row) : null;
  }

  async createDocument(input: DocumentDetails) {
    const { id } = await this.tx.document.create({
      data: {
        ...this.scope,
        ...input,
        expiresOn: asDate(input.expiresOn) ?? null,
        createdByUserId: this.userId,
      },
      select: { id: true },
    });
    return id;
  }

  async updateDocument(id: string, patch: Partial<DocumentDetails> & { status?: 'ARCHIVED' }) {
    const { expiresOn, ...rest } = patch;
    await this.tx.document.updateMany({
      where: { ...this.scope, id },
      data: { ...rest, ...(expiresOn !== undefined ? { expiresOn: asDate(expiresOn) } : {}) },
    });
  }

  async createVersion(input: {
    id: string;
    documentId: string;
    storageKey: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    note: string | null;
  }) {
    await this.tx.documentVersion.create({
      data: { ...this.scope, ...input, uploadedByUserId: this.userId },
    });
  }

  async setVersionStatus(id: string, status: 'READY' | 'REJECTED') {
    await this.tx.documentVersion.updateMany({
      where: { ...this.scope, id, status: 'PENDING' },
      data: { status },
    });
  }

  async audit(event: {
    action: string;
    resourceId: string;
    metadata?: Record<string, string | number | boolean>;
  }) {
    await this.tx.auditLog.createMany({
      data: [
        {
          organisationId: this.organisationId,
          actorUserId: this.userId,
          action: event.action,
          resourceType: 'document',
          resourceId: event.resourceId,
          metadata: { propertyId: this.propertyId, ...(event.metadata ?? {}) },
          requestId: clip(this.meta.requestId, 128),
          ipAddress: clip(this.meta.ipAddress, 64),
        },
      ],
    });
  }
}

/** Document persistence over Prisma, always inside the organisation's RLS context. */
@Injectable()
export class PrismaDocumentRepository implements DocumentRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: DocumentUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaDocumentUnitOfWork(tx, organisationId, propertyId, userId, meta)),
      { userId },
    );
  }
}

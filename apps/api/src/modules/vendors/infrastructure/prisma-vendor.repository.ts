import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, type DbTransaction, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import type {
  DocumentRecord,
  VendorDetails,
  VendorRecord,
  VendorRepository,
  VendorUnitOfWork,
} from '../application/vendor-ports';
import type { DocumentKind, VendorStatus } from '../domain/vendor-rules';

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const asDate = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`) : null);

const VENDOR_SELECT = {
  id: true,
  name: true,
  categories: true,
  contactName: true,
  email: true,
  phone: true,
  taxReference: true,
  notes: true,
  status: true,
  statusNote: true,
  archivedAt: true,
  createdAt: true,
} as const;

const DOCUMENT_SELECT = {
  id: true,
  vendorId: true,
  kind: true,
  title: true,
  reference: true,
  validFrom: true,
  expiresOn: true,
  createdAt: true,
  voidedAt: true,
  voidReason: true,
  createdBy: { select: { displayName: true } },
} as const;

const toDocument = (row: {
  id: string;
  vendorId: string;
  kind: DocumentKind;
  title: string;
  reference: string | null;
  validFrom: Date | null;
  expiresOn: Date | null;
  createdAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
  createdBy: { displayName: string };
}): DocumentRecord => ({
  id: row.id,
  vendorId: row.vendorId,
  kind: row.kind,
  title: row.title,
  reference: row.reference,
  validFrom: day(row.validFrom),
  expiresOn: day(row.expiresOn),
  createdByName: row.createdBy.displayName,
  createdAt: row.createdAt,
  voidedAt: row.voidedAt,
  voidReason: row.voidReason,
});

class PrismaVendorUnitOfWork implements VendorUnitOfWork {
  constructor(
    private readonly tx: DbTransaction,
    private readonly organisationId: string,
    private readonly userId: string,
    private readonly meta: RequestMeta,
  ) {}

  async today() {
    const rows = await this.tx.$queryRaw<{ today: string }[]>`
      SELECT to_char((now() AT TIME ZONE "default_time_zone")::date, 'YYYY-MM-DD') AS today
        FROM "organisations" WHERE "id" = ${this.organisationId}::uuid`;
    const today = rows[0]?.today;
    if (!today) throw new Error('Organisation vanished inside its own transaction');
    return today;
  }

  vendors(status?: VendorStatus): Promise<VendorRecord[]> {
    return this.tx.vendor.findMany({
      where: { organisationId: this.organisationId, ...(status ? { status } : {}) },
      select: VENDOR_SELECT,
      orderBy: { name: 'asc' },
      take: 500,
    });
  }

  vendor(id: string) {
    return this.tx.vendor.findFirst({
      where: { organisationId: this.organisationId, id },
      select: VENDOR_SELECT,
    });
  }

  async nameTaken(name: string, exceptId?: string) {
    const found = await this.tx.vendor.findFirst({
      where: {
        organisationId: this.organisationId,
        name: { equals: name, mode: 'insensitive' },
        status: { not: 'ARCHIVED' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    return found !== null;
  }

  async createVendor(input: VendorDetails) {
    const { id } = await this.tx.vendor.create({
      data: { organisationId: this.organisationId, ...input },
      select: { id: true },
    });
    return id;
  }

  async updateVendor(
    id: string,
    patch: Partial<VendorDetails> & { status?: VendorStatus; statusNote?: string | null },
  ) {
    await this.tx.vendor.updateMany({
      where: { organisationId: this.organisationId, id },
      data: patch,
    });
  }

  openWorkCount(vendorId: string) {
    return this.tx.workOrder.count({
      where: {
        organisationId: this.organisationId,
        vendorId,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
      },
    });
  }

  async documents(vendorIds: string[]) {
    if (vendorIds.length === 0) return [];
    const rows = await this.tx.vendorDocument.findMany({
      where: { organisationId: this.organisationId, vendorId: { in: vendorIds } },
      select: DOCUMENT_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toDocument);
  }

  async document(id: string) {
    const row = await this.tx.vendorDocument.findFirst({
      where: { organisationId: this.organisationId, id },
      select: DOCUMENT_SELECT,
    });
    return row ? toDocument(row) : null;
  }

  async createDocument(input: {
    vendorId: string;
    kind: DocumentKind;
    title: string;
    reference: string | null;
    validFrom: string | null;
    expiresOn: string | null;
  }) {
    const { id } = await this.tx.vendorDocument.create({
      data: {
        organisationId: this.organisationId,
        vendorId: input.vendorId,
        kind: input.kind,
        title: input.title,
        reference: input.reference,
        validFrom: asDate(input.validFrom),
        expiresOn: asDate(input.expiresOn),
        createdByUserId: this.userId,
      },
      select: { id: true },
    });
    return id;
  }

  async voidDocument(id: string, reason: string) {
    await this.tx.vendorDocument.updateMany({
      where: { organisationId: this.organisationId, id },
      data: { voidedAt: new Date(), voidedByUserId: this.userId, voidReason: reason },
    });
  }

  async audit(event: {
    action: string;
    resourceType: 'vendor' | 'vendor_document';
    resourceId: string;
    metadata?: Record<string, string | number | boolean>;
  }) {
    await this.tx.auditLog.createMany({
      data: [
        {
          organisationId: this.organisationId,
          actorUserId: this.userId,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          metadata: event.metadata ?? {},
          requestId: clip(this.meta.requestId, 128),
          ipAddress: clip(this.meta.ipAddress, 64),
        },
      ],
    });
  }
}

/** Vendor persistence over Prisma, always inside the organisation's RLS context. */
@Injectable()
export class PrismaVendorRepository implements VendorRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inOrganisation<T>(
    organisationId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: VendorUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaVendorUnitOfWork(tx, organisationId, userId, meta)),
      { userId },
    );
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, type DbTransaction, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import type {
  AssetFields,
  AssetRecord,
  AssetRepository,
  AssetUnitOfWork,
  AssetWorkRecord,
  ScheduleFields,
  ScheduleRecord,
} from '../application/asset-ports';
import type { AssetStatus } from '../domain/asset-rules';

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const asDate = (d: string | null | undefined) =>
  d === undefined ? undefined : d === null ? null : new Date(`${d}T00:00:00Z`);

const ASSET_SELECT = {
  id: true,
  tag: true,
  name: true,
  category: true,
  unitId: true,
  commonAreaId: true,
  manufacturer: true,
  model: true,
  serialNumber: true,
  installedOn: true,
  warrantyExpiresOn: true,
  supplierVendorId: true,
  notes: true,
  status: true,
  statusNote: true,
  retiredAt: true,
  createdAt: true,
  unit: { select: { number: true } },
  commonArea: { select: { name: true } },
  supplier: { select: { name: true } },
} as const;

const SCHEDULE_SELECT = {
  id: true,
  assetId: true,
  title: true,
  description: true,
  priority: true,
  intervalUnit: true,
  intervalCount: true,
  nextDueOn: true,
  leadDays: true,
  vendorId: true,
  active: true,
  createdAt: true,
  vendor: { select: { name: true } },
} as const;

type AssetRow = Omit<
  AssetRecord,
  'installedOn' | 'warrantyExpiresOn' | 'unitNumber' | 'commonAreaName' | 'supplierName'
> & {
  installedOn: Date | null;
  warrantyExpiresOn: Date | null;
  unit: { number: string } | null;
  commonArea: { name: string } | null;
  supplier: { name: string } | null;
};

const toAsset = ({ unit, commonArea, supplier, ...row }: AssetRow): AssetRecord => ({
  ...row,
  installedOn: day(row.installedOn),
  warrantyExpiresOn: day(row.warrantyExpiresOn),
  unitNumber: unit?.number ?? null,
  commonAreaName: commonArea?.name ?? null,
  supplierName: supplier?.name ?? null,
});

type ScheduleRow = Omit<ScheduleRecord, 'nextDueOn' | 'vendorName'> & {
  nextDueOn: Date;
  vendor: { name: string } | null;
};

const toSchedule = ({ vendor, ...row }: ScheduleRow): ScheduleRecord => ({
  ...row,
  nextDueOn: day(row.nextDueOn) as string,
  vendorName: vendor?.name ?? null,
});

/** Dates as Prisma expects them; undefined stays undefined (not changed). */
function fields<T extends Partial<AssetFields>>(input: T) {
  const { installedOn, warrantyExpiresOn, ...rest } = input;
  return {
    ...rest,
    ...(installedOn !== undefined ? { installedOn: asDate(installedOn) } : {}),
    ...(warrantyExpiresOn !== undefined ? { warrantyExpiresOn: asDate(warrantyExpiresOn) } : {}),
  };
}

class PrismaAssetUnitOfWork implements AssetUnitOfWork {
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

  async place(unitId: string | null, commonAreaId: string | null) {
    if (unitId) {
      return (
        (await this.tx.unit.count({ where: { ...this.scope, id: unitId, status: 'ACTIVE' } })) > 0
      );
    }
    if (commonAreaId) {
      return (
        (await this.tx.commonArea.count({
          where: { ...this.scope, id: commonAreaId, status: 'ACTIVE' },
        })) > 0
      );
    }
    return false;
  }

  vendor(id: string) {
    return this.tx.vendor.findFirst({
      where: { organisationId: this.organisationId, id },
      select: { id: true, status: true },
    });
  }

  async assets(status?: AssetStatus) {
    const rows = await this.tx.asset.findMany({
      where: { ...this.scope, ...(status ? { status } : {}) },
      select: ASSET_SELECT,
      orderBy: { tag: 'asc' },
      take: 500,
    });
    return rows.map(toAsset);
  }

  async asset(id: string) {
    const row = await this.tx.asset.findFirst({
      where: { ...this.scope, id },
      select: ASSET_SELECT,
    });
    return row ? toAsset(row) : null;
  }

  async tagTaken(tag: string) {
    return (await this.tx.asset.count({ where: { ...this.scope, tag } })) > 0;
  }

  async createAsset(input: AssetFields & { tag: string }) {
    const { id } = await this.tx.asset.create({
      data: { ...this.scope, ...fields(input) },
      select: { id: true },
    });
    return id;
  }

  async updateAsset(
    id: string,
    patch: Partial<AssetFields> & { status?: AssetStatus; statusNote?: string | null },
  ) {
    await this.tx.asset.updateMany({ where: { ...this.scope, id }, data: fields(patch) });
  }

  async schedules(filter: { assetId?: string; activeOnly?: boolean }) {
    const rows = await this.tx.maintenanceSchedule.findMany({
      where: {
        ...this.scope,
        ...(filter.assetId ? { assetId: filter.assetId } : {}),
        ...(filter.activeOnly ? { active: true } : {}),
      },
      select: SCHEDULE_SELECT,
      orderBy: [{ nextDueOn: 'asc' }, { title: 'asc' }],
    });
    return rows.map(toSchedule);
  }

  async schedule(id: string) {
    const row = await this.tx.maintenanceSchedule.findFirst({
      where: { ...this.scope, id },
      select: SCHEDULE_SELECT,
    });
    return row ? toSchedule(row) : null;
  }

  async createSchedule(input: ScheduleFields & { assetId: string }) {
    const { id } = await this.tx.maintenanceSchedule.create({
      data: {
        ...this.scope,
        ...input,
        nextDueOn: new Date(`${input.nextDueOn}T00:00:00Z`),
        createdByUserId: this.userId,
      },
      select: { id: true },
    });
    return id;
  }

  async updateSchedule(id: string, patch: Partial<ScheduleFields>) {
    const { nextDueOn, ...rest } = patch;
    await this.tx.maintenanceSchedule.updateMany({
      where: { ...this.scope, id },
      data: { ...rest, ...(nextDueOn ? { nextDueOn: new Date(`${nextDueOn}T00:00:00Z`) } : {}) },
    });
  }

  async history(assetId: string): Promise<AssetWorkRecord[]> {
    const rows = await this.tx.workOrder.findMany({
      where: { ...this.scope, assetId },
      select: {
        id: true,
        workOrderNumber: true,
        title: true,
        status: true,
        scheduledFor: true,
        completedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      number: r.workOrderNumber ?? 0n,
      title: r.title,
      status: r.status,
      scheduledFor: day(r.scheduledFor),
      completedAt: r.completedAt,
      createdAt: r.createdAt,
    }));
  }

  async raiseWork(input: {
    asset: AssetRecord;
    schedule: ScheduleRecord;
    dueOn: string;
    vendorId: string | null;
  }) {
    const { asset, schedule, dueOn, vendorId } = input;
    const due = await this.tx.$queryRaw<{ at: Date }[]>`
      SELECT ((${dueOn}::date + time '23:59') AT TIME ZONE "time_zone") AS at
        FROM "properties" WHERE "id" = ${this.propertyId}::uuid`;
    const row = await this.tx.workOrder.create({
      data: {
        ...this.scope,
        unitId: asset.unitId,
        commonAreaId: asset.commonAreaId,
        category: asset.category,
        priority: schedule.priority,
        title: schedule.title,
        description: schedule.description,
        status: vendorId ? 'ASSIGNED' : 'OPEN',
        vendorId,
        assetId: asset.id,
        scheduleId: schedule.id,
        scheduledFor: new Date(`${dueOn}T00:00:00Z`),
        dueAt: due[0]?.at ?? null,
        createdByUserId: this.userId,
      },
      select: { id: true, workOrderNumber: true },
    });
    return { id: row.id, number: row.workOrderNumber ?? 0n };
  }

  async audit(event: {
    action: string;
    resourceType: 'asset' | 'maintenance_schedule' | 'work_order';
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
          metadata: { propertyId: this.propertyId, ...(event.metadata ?? {}) },
          requestId: clip(this.meta.requestId, 128),
          ipAddress: clip(this.meta.ipAddress, 64),
        },
      ],
    });
  }
}

/** Asset persistence over Prisma, always inside the organisation's RLS context. */
@Injectable()
export class PrismaAssetRepository implements AssetRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: AssetUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaAssetUnitOfWork(tx, organisationId, propertyId, userId, meta)),
      { userId },
    );
  }
}

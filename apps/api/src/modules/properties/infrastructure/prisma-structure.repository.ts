import { Inject, Injectable } from '@nestjs/common';
import {
  type DbClient,
  type DbTransaction,
  isUniqueViolation,
  withTenantTransaction,
} from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import type { Page, PropertyRecord } from '../application/ports';
import {
  type BuildingRecord,
  type CommonAreaRecord,
  type FloorRecord,
  type ListOptions,
  type PropertyUnitOfWork,
  type StructureAuditEvent,
  StructureConflictError,
  type StructureRepository,
  type UnitRecord,
} from '../application/structure-ports';
import type {
  CreateBuildingInput,
  CreateCommonAreaInput,
  CreateFloorInput,
  UnitType,
  UpdateBuildingInput,
  UpdateCommonAreaInput,
  UpdateFloorInput,
  UpdatePropertyInput,
} from '../domain/structure-rules';

const PROPERTY_SELECT = {
  id: true,
  organisationId: true,
  name: true,
  code: true,
  type: true,
  status: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  region: true,
  postalCode: true,
  countryCode: true,
  timeZone: true,
  currency: true,
  createdAt: true,
} as const;

const STATUS_FIELDS = { status: true, archivedAt: true, createdAt: true } as const;
const BUILDING_SELECT = {
  id: true,
  propertyId: true,
  name: true,
  code: true,
  ...STATUS_FIELDS,
} as const;
const FLOOR_SELECT = {
  id: true,
  propertyId: true,
  buildingId: true,
  level: true,
  name: true,
  ...STATUS_FIELDS,
} as const;
const COMMON_AREA_SELECT = {
  id: true,
  propertyId: true,
  buildingId: true,
  name: true,
  type: true,
  ...STATUS_FIELDS,
} as const;
const UNIT_SELECT = {
  id: true,
  propertyId: true,
  buildingId: true,
  floorId: true,
  number: true,
  type: true,
  areaSqm: true,
  shareRatio: true,
  ...STATUS_FIELDS,
} as const;

/** Prisma returns DECIMAL as a decimal.js value; the API exposes fixed-scale strings. */
type DecimalLike = { toFixed(digits: number): string } | null;
function toUnitRecord(row: {
  id: string;
  propertyId: string;
  buildingId: string | null;
  floorId: string | null;
  number: string;
  type: UnitType;
  areaSqm: DecimalLike;
  shareRatio: DecimalLike;
  status: 'ACTIVE' | 'ARCHIVED';
  archivedAt: Date | null;
  createdAt: Date;
}): UnitRecord {
  return {
    ...row,
    areaSqm: row.areaSqm ? row.areaSqm.toFixed(2) : null,
    shareRatio: row.shareRatio ? row.shareRatio.toFixed(6) : null,
  };
}

/** Keyset pagination on UUIDv7 ids: fetch one extra row to know whether a next page exists. */
function toPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  const data = rows.slice(0, limit);
  return { data, nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null };
}
const pageArgs = (options: ListOptions) => ({
  orderBy: { id: 'asc' as const },
  take: options.limit + 1,
});
const idAfter = (options: ListOptions) => (options.cursor ? { id: { gt: options.cursor } } : {});

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

async function conflictAs<T>(code: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isUniqueViolation(error)) throw new StructureConflictError(code);
    throw error;
  }
}

class PrismaPropertyUnitOfWork implements PropertyUnitOfWork {
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

  /** Row lock without loading: FOR SHARE blocks archiving while a child is created. */
  private async lock(
    table: string,
    id: string,
    mode: 'share' | 'update',
    extra = '',
  ): Promise<boolean> {
    const clause = mode === 'share' ? 'FOR SHARE' : 'FOR NO KEY UPDATE';
    const rows = await this.tx.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM ${table} WHERE id = $1::uuid AND organisation_id = $2::uuid ${extra} ${clause}`,
      id,
      this.organisationId,
      this.propertyId,
    );
    return rows.length > 0;
  }

  // ---------------------------------------------------------------------------- property

  async lockProperty(mode: 'share' | 'update'): Promise<PropertyRecord | null> {
    // $3 (property id) is unused here but keeps the parameter list uniform.
    if (!(await this.lock('properties', this.propertyId, mode, 'AND id = $3::uuid'))) return null;
    return this.tx.property.findFirst({
      where: { id: this.propertyId, organisationId: this.organisationId },
      select: PROPERTY_SELECT,
    });
  }

  updateProperty(patch: UpdatePropertyInput): Promise<PropertyRecord> {
    return this.tx.property.update({
      where: { id: this.propertyId },
      data: patch,
      select: PROPERTY_SELECT,
    });
  }

  setPropertyStatus(status: 'ACTIVE' | 'ARCHIVED', at: Date): Promise<PropertyRecord> {
    return this.tx.property.update({
      where: { id: this.propertyId },
      data: { status, archivedAt: status === 'ARCHIVED' ? at : null },
      select: PROPERTY_SELECT,
    });
  }

  async archiveAllStructure(at: Date) {
    const where = { ...this.scope, status: 'ACTIVE' as const };
    const data = { status: 'ARCHIVED' as const, archivedAt: at };
    const units = await this.tx.unit.updateMany({ where, data });
    const commonAreas = await this.tx.commonArea.updateMany({ where, data });
    const floors = await this.tx.floor.updateMany({ where, data });
    const buildings = await this.tx.building.updateMany({ where, data });
    return {
      buildings: buildings.count,
      floors: floors.count,
      units: units.count,
      commonAreas: commonAreas.count,
    };
  }

  // ---------------------------------------------------------------------------- buildings

  async listBuildings(options: ListOptions): Promise<Page<BuildingRecord>> {
    const rows = await this.tx.building.findMany({
      where: { ...this.scope, status: options.status, ...idAfter(options) },
      ...pageArgs(options),
      select: BUILDING_SELECT,
    });
    return toPage(rows, options.limit);
  }

  async lockBuilding(buildingId: string, mode: 'share' | 'update'): Promise<BuildingRecord | null> {
    if (!(await this.lock('buildings', buildingId, mode, 'AND property_id = $3::uuid')))
      return null;
    return this.tx.building.findFirst({
      where: { id: buildingId, ...this.scope },
      select: BUILDING_SELECT,
    });
  }

  createBuilding(input: CreateBuildingInput): Promise<BuildingRecord> {
    return conflictAs('BUILDING_CODE_TAKEN', () =>
      this.tx.building.create({ data: { ...this.scope, ...input }, select: BUILDING_SELECT }),
    );
  }

  updateBuilding(buildingId: string, patch: UpdateBuildingInput): Promise<BuildingRecord> {
    return conflictAs('BUILDING_CODE_TAKEN', () =>
      this.tx.building.update({ where: { id: buildingId }, data: patch, select: BUILDING_SELECT }),
    );
  }

  async archiveBuilding(buildingId: string, at: Date): Promise<BuildingRecord> {
    const data = { status: 'ARCHIVED' as const, archivedAt: at };
    const active = { ...this.scope, buildingId, status: 'ACTIVE' as const };
    await this.tx.floor.updateMany({ where: active, data });
    await this.tx.commonArea.updateMany({ where: active, data });
    return this.tx.building.update({ where: { id: buildingId }, data, select: BUILDING_SELECT });
  }

  // ---------------------------------------------------------------------------- floors

  async listFloors(buildingId: string, options: ListOptions): Promise<Page<FloorRecord>> {
    const rows = await this.tx.floor.findMany({
      where: { ...this.scope, buildingId, status: options.status, ...idAfter(options) },
      ...pageArgs(options),
      select: FLOOR_SELECT,
    });
    return toPage(rows, options.limit);
  }

  async lockFloor(
    buildingId: string,
    floorId: string,
    mode: 'share' | 'update',
  ): Promise<FloorRecord | null> {
    if (!(await this.lock('floors', floorId, mode, 'AND property_id = $3::uuid'))) return null;
    return this.tx.floor.findFirst({
      where: { id: floorId, buildingId, ...this.scope },
      select: FLOOR_SELECT,
    });
  }

  createFloor(buildingId: string, input: CreateFloorInput): Promise<FloorRecord> {
    return conflictAs('FLOOR_LEVEL_TAKEN', () =>
      this.tx.floor.create({ data: { ...this.scope, buildingId, ...input }, select: FLOOR_SELECT }),
    );
  }

  updateFloor(floorId: string, patch: UpdateFloorInput): Promise<FloorRecord> {
    return conflictAs('FLOOR_LEVEL_TAKEN', () =>
      this.tx.floor.update({ where: { id: floorId }, data: patch, select: FLOOR_SELECT }),
    );
  }

  archiveFloor(floorId: string, at: Date): Promise<FloorRecord> {
    return this.tx.floor.update({
      where: { id: floorId },
      data: { status: 'ARCHIVED', archivedAt: at },
      select: FLOOR_SELECT,
    });
  }

  // ---------------------------------------------------------------------------- units

  countActiveUnits(where: { buildingId: string } | { floorId: string }): Promise<number> {
    return this.tx.unit.count({ where: { ...this.scope, ...where, status: 'ACTIVE' } });
  }

  async listUnits(
    options: ListOptions & { buildingId?: string | undefined; floorId?: string | undefined },
  ): Promise<Page<UnitRecord>> {
    const rows = await this.tx.unit.findMany({
      where: {
        ...this.scope,
        status: options.status,
        ...(options.buildingId ? { buildingId: options.buildingId } : {}),
        ...(options.floorId ? { floorId: options.floorId } : {}),
        ...idAfter(options),
      },
      ...pageArgs(options),
      select: UNIT_SELECT,
    });
    return toPage(rows.map(toUnitRecord), options.limit);
  }

  async lockUnit(unitId: string): Promise<UnitRecord | null> {
    if (!(await this.lock('units', unitId, 'update', 'AND property_id = $3::uuid'))) return null;
    const row = await this.tx.unit.findFirst({
      where: { id: unitId, ...this.scope },
      select: UNIT_SELECT,
    });
    return row ? toUnitRecord(row) : null;
  }

  async createUnit(input: {
    number: string;
    type: UnitType;
    buildingId: string | null;
    floorId: string | null;
    areaSqm: string | null;
    shareRatio: string | null;
  }): Promise<UnitRecord> {
    const row = await conflictAs('UNIT_NUMBER_TAKEN', () =>
      this.tx.unit.create({ data: { ...this.scope, ...input }, select: UNIT_SELECT }),
    );
    return toUnitRecord(row);
  }

  async updateUnit(
    unitId: string,
    patch: {
      number?: string;
      type?: UnitType;
      areaSqm?: string | null;
      shareRatio?: string | null;
    },
  ): Promise<UnitRecord> {
    const row = await conflictAs('UNIT_NUMBER_TAKEN', () =>
      this.tx.unit.update({ where: { id: unitId }, data: patch, select: UNIT_SELECT }),
    );
    return toUnitRecord(row);
  }

  async archiveUnit(unitId: string, at: Date): Promise<UnitRecord> {
    const row = await this.tx.unit.update({
      where: { id: unitId },
      data: { status: 'ARCHIVED', archivedAt: at },
      select: UNIT_SELECT,
    });
    return toUnitRecord(row);
  }

  async isUnitOccupied(unitId: string): Promise<boolean> {
    const [row] = await this.tx.$queryRaw<{ occupied: boolean }[]>`
      SELECT app_unit_is_occupied(${unitId}::uuid) AS occupied`;
    return row?.occupied === true;
  }

  async lockUnitsAndCountOccupied(): Promise<number> {
    await this.tx.$queryRaw`
      SELECT id FROM units
       WHERE organisation_id = ${this.organisationId}::uuid AND property_id = ${this.propertyId}::uuid
       FOR NO KEY UPDATE`;
    const [row] = await this.tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM units
       WHERE organisation_id = ${this.organisationId}::uuid AND property_id = ${this.propertyId}::uuid
         AND app_unit_is_occupied(id)`;
    return row?.n ?? 0;
  }

  // ---------------------------------------------------------------------------- common areas

  async listCommonAreas(options: ListOptions): Promise<Page<CommonAreaRecord>> {
    const rows = await this.tx.commonArea.findMany({
      where: { ...this.scope, status: options.status, ...idAfter(options) },
      ...pageArgs(options),
      select: COMMON_AREA_SELECT,
    });
    return toPage(rows, options.limit);
  }

  async lockCommonArea(commonAreaId: string): Promise<CommonAreaRecord | null> {
    if (!(await this.lock('common_areas', commonAreaId, 'update', 'AND property_id = $3::uuid')))
      return null;
    return this.tx.commonArea.findFirst({
      where: { id: commonAreaId, ...this.scope },
      select: COMMON_AREA_SELECT,
    });
  }

  createCommonArea(input: CreateCommonAreaInput): Promise<CommonAreaRecord> {
    return conflictAs('COMMON_AREA_NAME_TAKEN', () =>
      this.tx.commonArea.create({
        data: {
          ...this.scope,
          name: input.name,
          type: input.type,
          buildingId: input.buildingId ?? null,
        },
        select: COMMON_AREA_SELECT,
      }),
    );
  }

  updateCommonArea(commonAreaId: string, patch: UpdateCommonAreaInput): Promise<CommonAreaRecord> {
    return conflictAs('COMMON_AREA_NAME_TAKEN', () =>
      this.tx.commonArea.update({
        where: { id: commonAreaId },
        data: patch,
        select: COMMON_AREA_SELECT,
      }),
    );
  }

  archiveCommonArea(commonAreaId: string, at: Date): Promise<CommonAreaRecord> {
    return this.tx.commonArea.update({
      where: { id: commonAreaId },
      data: { status: 'ARCHIVED', archivedAt: at },
      select: COMMON_AREA_SELECT,
    });
  }

  // ---------------------------------------------------------------------------- audit

  async audit(event: StructureAuditEvent): Promise<void> {
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

@Injectable()
export class PrismaStructureRepository implements StructureRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: PropertyUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId, propertyId },
      (tx) => work(new PrismaPropertyUnitOfWork(tx, organisationId, propertyId, userId, meta)),
      { userId },
    );
  }
}

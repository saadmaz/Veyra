import type { RequestMeta } from '../../../platform/request-meta';
import type {
  CommonAreaType,
  CreateBuildingInput,
  CreateCommonAreaInput,
  CreateFloorInput,
  UnitType,
  UpdateBuildingInput,
  UpdateCommonAreaInput,
  UpdateFloorInput,
  UpdatePropertyInput,
} from '../domain/structure-rules';
import type { Page, PropertyRecord } from './ports';

export type StructureStatus = 'ACTIVE' | 'ARCHIVED';

export interface BuildingRecord {
  id: string;
  propertyId: string;
  name: string;
  code: string;
  status: StructureStatus;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface FloorRecord {
  id: string;
  propertyId: string;
  buildingId: string;
  level: number;
  name: string;
  status: StructureStatus;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface UnitRecord {
  id: string;
  propertyId: string;
  buildingId: string | null;
  floorId: string | null;
  number: string;
  type: UnitType;
  /** Decimal as a string ("85.50"); never a float. */
  areaSqm: string | null;
  shareRatio: string | null;
  status: StructureStatus;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface CommonAreaRecord {
  id: string;
  propertyId: string;
  buildingId: string | null;
  name: string;
  type: CommonAreaType;
  status: StructureStatus;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface StructureAuditEvent {
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ListOptions {
  status: StructureStatus;
  limit: number;
  cursor?: string | undefined;
}

/** A unique rule was violated (code, level, number or name already used). */
export class StructureConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * Operations inside one transaction scoped to one property of one organisation (RLS context
 * set, every query filtered by organisation and property). Locks follow one rule: creating
 * something takes a SHARE lock on its parent, archiving takes an UPDATE lock on the archived
 * row first, so a create and an archive of the same parent are serialised.
 */
export interface PropertyUnitOfWork {
  /** Locks the property row (share for creating inside it, update for changing it). */
  lockProperty(mode: 'share' | 'update'): Promise<PropertyRecord | null>;
  updateProperty(patch: UpdatePropertyInput): Promise<PropertyRecord>;
  setPropertyStatus(status: 'ACTIVE' | 'ARCHIVED', at: Date): Promise<PropertyRecord>;
  /** Archives every active building, floor, unit and common area of the property. */
  archiveAllStructure(
    at: Date,
  ): Promise<{ buildings: number; floors: number; units: number; commonAreas: number }>;

  listBuildings(options: ListOptions): Promise<Page<BuildingRecord>>;
  lockBuilding(buildingId: string, mode: 'share' | 'update'): Promise<BuildingRecord | null>;
  createBuilding(input: CreateBuildingInput): Promise<BuildingRecord>;
  updateBuilding(buildingId: string, patch: UpdateBuildingInput): Promise<BuildingRecord>;
  /** Archives the building, its floors and its common areas (units must already be archived). */
  archiveBuilding(buildingId: string, at: Date): Promise<BuildingRecord>;

  listFloors(buildingId: string, options: ListOptions): Promise<Page<FloorRecord>>;
  lockFloor(
    buildingId: string,
    floorId: string,
    mode: 'share' | 'update',
  ): Promise<FloorRecord | null>;
  createFloor(buildingId: string, input: CreateFloorInput): Promise<FloorRecord>;
  updateFloor(floorId: string, patch: UpdateFloorInput): Promise<FloorRecord>;
  archiveFloor(floorId: string, at: Date): Promise<FloorRecord>;

  countActiveUnits(where: { buildingId: string } | { floorId: string }): Promise<number>;
  listUnits(
    options: ListOptions & { buildingId?: string | undefined; floorId?: string | undefined },
  ): Promise<Page<UnitRecord>>;
  lockUnit(unitId: string): Promise<UnitRecord | null>;
  createUnit(input: {
    number: string;
    type: UnitType;
    buildingId: string | null;
    floorId: string | null;
    areaSqm: string | null;
    shareRatio: string | null;
  }): Promise<UnitRecord>;
  updateUnit(
    unitId: string,
    patch: {
      number?: string;
      type?: UnitType;
      areaSqm?: string | null;
      shareRatio?: string | null;
    },
  ): Promise<UnitRecord>;
  archiveUnit(unitId: string, at: Date): Promise<UnitRecord>;
  /** app_unit_is_occupied: a current or future ownership, tenancy or household record exists. */
  isUnitOccupied(unitId: string): Promise<boolean>;
  /** Locks every unit of the property, then counts the occupied ones. */
  lockUnitsAndCountOccupied(): Promise<number>;

  listCommonAreas(options: ListOptions): Promise<Page<CommonAreaRecord>>;
  lockCommonArea(commonAreaId: string): Promise<CommonAreaRecord | null>;
  createCommonArea(input: CreateCommonAreaInput): Promise<CommonAreaRecord>;
  updateCommonArea(commonAreaId: string, patch: UpdateCommonAreaInput): Promise<CommonAreaRecord>;
  archiveCommonArea(commonAreaId: string, at: Date): Promise<CommonAreaRecord>;

  audit(event: StructureAuditEvent): Promise<void>;
}

export interface StructureRepository {
  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: PropertyUnitOfWork) => Promise<T>,
  ): Promise<T>;
}
export const STRUCTURE_REPOSITORY = Symbol('STRUCTURE_REPOSITORY');

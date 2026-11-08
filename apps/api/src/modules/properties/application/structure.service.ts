import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../platform/clock';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import type { OrganisationAccess } from '../../access-control';
import type {
  CreateBuildingInput,
  CreateCommonAreaInput,
  CreateFloorInput,
  CreateUnitInput,
  StructureListQuery,
  UnitListQuery,
  UpdateBuildingInput,
  UpdateCommonAreaInput,
  UpdateFloorInput,
  UpdatePropertyInput,
  UpdateUnitInput,
} from '../domain/structure-rules';
import type { Page, PropertyRecord } from './ports';
import {
  type BuildingRecord,
  type CommonAreaRecord,
  type FloorRecord,
  type PropertyUnitOfWork,
  STRUCTURE_REPOSITORY,
  StructureConflictError,
  type StructureRepository,
  type UnitRecord,
} from './structure-ports';

const CONFLICT_MESSAGES: Record<string, string> = {
  BUILDING_CODE_TAKEN: 'Another building in this property already uses this code',
  FLOOR_LEVEL_TAKEN: 'This building already has a floor at this level',
  UNIT_NUMBER_TAKEN: 'This unit number is already used here',
  COMMON_AREA_NAME_TAKEN: 'Another common area in this property already has this name',
};

const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);
const archived = (what: string) =>
  new ApiError(409, 'ARCHIVED', `This ${what} is archived and can no longer be changed`);

/**
 * Property settings, lifecycle and structure (buildings, floors, units, common areas).
 *
 * Every operation runs in one transaction scoped to the property. Writes lock the property
 * (share), then their parent (share) or the changed row (update), and re-check that nothing on
 * the path is archived, so a concurrent archive cannot leave an active child under an archived
 * parent. Every change writes its audit record in the same transaction.
 */
@Injectable()
export class StructureService {
  constructor(
    @Inject(STRUCTURE_REPOSITORY) private readonly repository: StructureRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------------------ property

  updateProperty(access: OrganisationAccess, input: UpdatePropertyInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const property = await this.lockedProperty(uow, 'update');
      if (property.status === 'ARCHIVED') throw archived('property');
      if (
        (input.countryCode !== undefined || input.currency !== undefined) &&
        property.status !== 'ONBOARDING'
      ) {
        throw new ApiError(
          409,
          'PROPERTY_FINANCIALS_LOCKED',
          'Country and currency can only change while the property is onboarding',
        );
      }
      const updated = await uow.updateProperty(input);
      await uow.audit({
        action: 'property.updated',
        resourceType: 'property',
        resourceId: property.id,
        metadata: { fields: Object.keys(input).sort().join(',') },
      });
      return updated;
    });
  }

  /** ONBOARDING -> ACTIVE. Idempotent for an active property. */
  activateProperty(access: OrganisationAccess, meta: RequestMeta): Promise<PropertyRecord> {
    return this.inProperty(access, meta, async (uow) => {
      const property = await this.lockedProperty(uow, 'update');
      if (property.status === 'ACTIVE') return property;
      if (property.status === 'ARCHIVED') {
        throw new ApiError(
          409,
          'INVALID_STATE_TRANSITION',
          'An archived property cannot be activated',
        );
      }
      const updated = await uow.setPropertyStatus('ACTIVE', this.clock.now());
      await uow.audit({
        action: 'property.activated',
        resourceType: 'property',
        resourceId: property.id,
      });
      return updated;
    });
  }

  /**
   * Archives the property and its whole structure in one transaction. Archived properties stay
   * readable (history) but cannot change. Idempotent.
   */
  archiveProperty(access: OrganisationAccess, meta: RequestMeta): Promise<PropertyRecord> {
    return this.inProperty(access, meta, async (uow) => {
      const property = await this.lockedProperty(uow, 'update');
      if (property.status === 'ARCHIVED') return property;
      const at = this.clock.now();
      const counts = await uow.archiveAllStructure(at);
      const updated = await uow.setPropertyStatus('ARCHIVED', at);
      await uow.audit({
        action: 'property.archived',
        resourceType: 'property',
        resourceId: property.id,
        metadata: counts,
      });
      return updated;
    });
  }

  // ------------------------------------------------------------------------------ buildings

  listBuildings(access: OrganisationAccess, query: StructureListQuery, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => uow.listBuildings(query));
  }

  createBuilding(access: OrganisationAccess, input: CreateBuildingInput, meta: RequestMeta) {
    return this.write(access, meta, async (uow) => {
      const building = await uow.createBuilding(input);
      await uow.audit({
        action: 'building.created',
        resourceType: 'building',
        resourceId: building.id,
        metadata: { code: building.code },
      });
      return building;
    });
  }

  updateBuilding(
    access: OrganisationAccess,
    buildingId: string,
    input: UpdateBuildingInput,
    meta: RequestMeta,
  ) {
    return this.write(access, meta, async (uow) => {
      const building = await uow.lockBuilding(buildingId, 'update');
      if (!building) throw notFound('Building');
      if (building.status === 'ARCHIVED') throw archived('building');
      const updated = await uow.updateBuilding(buildingId, input);
      await uow.audit({
        action: 'building.updated',
        resourceType: 'building',
        resourceId: buildingId,
        metadata: { fields: Object.keys(input).sort().join(',') },
      });
      return updated;
    });
  }

  /** Requires the building to have no active units; archives its floors and common areas. */
  archiveBuilding(access: OrganisationAccess, buildingId: string, meta: RequestMeta) {
    return this.write(access, meta, async (uow) => {
      const building = await uow.lockBuilding(buildingId, 'update');
      if (!building) throw notFound('Building');
      if (building.status === 'ARCHIVED') return building;
      await this.requireNoActiveUnits(uow, { buildingId }, 'building');
      const updated = await uow.archiveBuilding(buildingId, this.clock.now());
      await uow.audit({
        action: 'building.archived',
        resourceType: 'building',
        resourceId: buildingId,
      });
      return updated;
    });
  }

  // ------------------------------------------------------------------------------ floors

  listFloors(
    access: OrganisationAccess,
    buildingId: string,
    query: StructureListQuery,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      if (!(await uow.lockBuilding(buildingId, 'share'))) throw notFound('Building');
      return uow.listFloors(buildingId, query);
    });
  }

  createFloor(
    access: OrganisationAccess,
    buildingId: string,
    input: CreateFloorInput,
    meta: RequestMeta,
  ) {
    return this.write(access, meta, async (uow) => {
      await this.activeBuilding(uow, buildingId);
      const floor = await uow.createFloor(buildingId, input);
      await uow.audit({
        action: 'floor.created',
        resourceType: 'floor',
        resourceId: floor.id,
        metadata: { level: floor.level },
      });
      return floor;
    });
  }

  updateFloor(
    access: OrganisationAccess,
    buildingId: string,
    floorId: string,
    input: UpdateFloorInput,
    meta: RequestMeta,
  ) {
    return this.write(access, meta, async (uow) => {
      const floor = await uow.lockFloor(buildingId, floorId, 'update');
      if (!floor) throw notFound('Floor');
      if (floor.status === 'ARCHIVED') throw archived('floor');
      const updated = await uow.updateFloor(floorId, input);
      await uow.audit({
        action: 'floor.updated',
        resourceType: 'floor',
        resourceId: floorId,
        metadata: { fields: Object.keys(input).sort().join(',') },
      });
      return updated;
    });
  }

  archiveFloor(access: OrganisationAccess, buildingId: string, floorId: string, meta: RequestMeta) {
    return this.write(access, meta, async (uow) => {
      const floor = await uow.lockFloor(buildingId, floorId, 'update');
      if (!floor) throw notFound('Floor');
      if (floor.status === 'ARCHIVED') return floor;
      await this.requireNoActiveUnits(uow, { floorId }, 'floor');
      const updated = await uow.archiveFloor(floorId, this.clock.now());
      await uow.audit({ action: 'floor.archived', resourceType: 'floor', resourceId: floorId });
      return updated;
    });
  }

  // ------------------------------------------------------------------------------ units

  listUnits(access: OrganisationAccess, query: UnitListQuery, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => uow.listUnits(query));
  }

  createUnit(access: OrganisationAccess, input: CreateUnitInput, meta: RequestMeta) {
    return this.write(access, meta, async (uow) => {
      if (input.buildingId) await this.activeBuilding(uow, input.buildingId);
      if (input.floorId && input.buildingId) {
        const floor = await uow.lockFloor(input.buildingId, input.floorId, 'share');
        if (!floor) throw notFound('Floor');
        if (floor.status === 'ARCHIVED') throw archived('floor');
      }
      const unit = await uow.createUnit({
        number: input.number,
        type: input.type,
        buildingId: input.buildingId ?? null,
        floorId: input.floorId ?? null,
        areaSqm: input.areaSqm ?? null,
        shareRatio: input.shareRatio ?? null,
      });
      await uow.audit({
        action: 'unit.created',
        resourceType: 'unit',
        resourceId: unit.id,
        metadata: { number: unit.number },
      });
      return unit;
    });
  }

  updateUnit(
    access: OrganisationAccess,
    unitId: string,
    input: UpdateUnitInput,
    meta: RequestMeta,
  ) {
    return this.write(access, meta, async (uow) => {
      const unit = await uow.lockUnit(unitId);
      if (!unit) throw notFound('Unit');
      if (unit.status === 'ARCHIVED') throw archived('unit');
      const updated = await uow.updateUnit(unitId, input);
      await uow.audit({
        action: 'unit.updated',
        resourceType: 'unit',
        resourceId: unitId,
        metadata: { fields: Object.keys(input).sort().join(',') },
      });
      return updated;
    });
  }

  /** Phase 4 adds: a unit with an active ownership or tenancy cannot be archived. */
  archiveUnit(access: OrganisationAccess, unitId: string, meta: RequestMeta) {
    return this.write(access, meta, async (uow) => {
      const unit = await uow.lockUnit(unitId);
      if (!unit) throw notFound('Unit');
      if (unit.status === 'ARCHIVED') return unit;
      const updated = await uow.archiveUnit(unitId, this.clock.now());
      await uow.audit({ action: 'unit.archived', resourceType: 'unit', resourceId: unitId });
      return updated;
    });
  }

  // ------------------------------------------------------------------------------ common areas

  listCommonAreas(access: OrganisationAccess, query: StructureListQuery, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => uow.listCommonAreas(query));
  }

  createCommonArea(access: OrganisationAccess, input: CreateCommonAreaInput, meta: RequestMeta) {
    return this.write(access, meta, async (uow) => {
      if (input.buildingId) await this.activeBuilding(uow, input.buildingId);
      const area = await uow.createCommonArea(input);
      await uow.audit({
        action: 'common_area.created',
        resourceType: 'common_area',
        resourceId: area.id,
      });
      return area;
    });
  }

  updateCommonArea(
    access: OrganisationAccess,
    commonAreaId: string,
    input: UpdateCommonAreaInput,
    meta: RequestMeta,
  ) {
    return this.write(access, meta, async (uow) => {
      const area = await uow.lockCommonArea(commonAreaId);
      if (!area) throw notFound('Common area');
      if (area.status === 'ARCHIVED') throw archived('common area');
      const updated = await uow.updateCommonArea(commonAreaId, input);
      await uow.audit({
        action: 'common_area.updated',
        resourceType: 'common_area',
        resourceId: commonAreaId,
        metadata: { fields: Object.keys(input).sort().join(',') },
      });
      return updated;
    });
  }

  archiveCommonArea(access: OrganisationAccess, commonAreaId: string, meta: RequestMeta) {
    return this.write(access, meta, async (uow) => {
      const area = await uow.lockCommonArea(commonAreaId);
      if (!area) throw notFound('Common area');
      if (area.status === 'ARCHIVED') return area;
      const updated = await uow.archiveCommonArea(commonAreaId, this.clock.now());
      await uow.audit({
        action: 'common_area.archived',
        resourceType: 'common_area',
        resourceId: commonAreaId,
      });
      return updated;
    });
  }

  // ------------------------------------------------------------------------------ helpers

  private inProperty<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: PropertyUnitOfWork) => Promise<T>,
  ): Promise<T> {
    if (!access.propertyId) throw new Error('Structure route without a resolved property');
    return this.mapConflicts(() =>
      this.repository.inProperty(
        access.organisationId,
        access.propertyId as string,
        access.userId,
        meta,
        work,
      ),
    );
  }

  /** A change inside the property: locks it (share) and refuses archived properties. */
  private write<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: PropertyUnitOfWork) => Promise<T>,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      const property = await this.lockedProperty(uow, 'share');
      if (property.status === 'ARCHIVED') throw archived('property');
      return work(uow);
    });
  }

  private async lockedProperty(uow: PropertyUnitOfWork, mode: 'share' | 'update') {
    const property = await uow.lockProperty(mode);
    if (!property) throw notFound('Property');
    return property;
  }

  private async activeBuilding(
    uow: PropertyUnitOfWork,
    buildingId: string,
  ): Promise<BuildingRecord> {
    const building = await uow.lockBuilding(buildingId, 'share');
    if (!building) throw notFound('Building');
    if (building.status === 'ARCHIVED') throw archived('building');
    return building;
  }

  private async requireNoActiveUnits(
    uow: PropertyUnitOfWork,
    where: { buildingId: string } | { floorId: string },
    what: string,
  ) {
    const active = await uow.countActiveUnits(where);
    if (active > 0) {
      throw new ApiError(
        409,
        'STRUCTURE_IN_USE',
        `This ${what} still has ${active} active unit${active === 1 ? '' : 's'}; archive or move them first`,
      );
    }
  }

  private async mapConflicts<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof StructureConflictError) {
        throw new ApiError(409, error.code, CONFLICT_MESSAGES[error.code] ?? 'Conflict');
      }
      throw error;
    }
  }
}

export type { BuildingRecord, CommonAreaRecord, FloorRecord, Page, UnitRecord };

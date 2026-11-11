import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../../platform/errors/api-error';
import type { OrganisationAccess } from '../../access-control';

export interface MyUnitRecord {
  unitId: string;
  unitNumber: string;
  unitType: string;
  propertyId: string;
  propertyName: string;
  buildingName: string | null;
  /** Today's derived roles on the unit, e.g. ["OWNER"] or ["OWNER", "TENANT"]. */
  roles: string[];
}

export interface UnitDetailRecord {
  unitId: string;
  unitNumber: string;
  unitType: string;
  status: string;
  areaSqm: string | null;
  propertyId: string;
  propertyName: string;
  /** IANA time zone: residents enter and read visit times in it. */
  propertyTimeZone: string;
  buildingName: string | null;
  floorName: string | null;
  /** The caller's own resident roles on this unit today (empty for staff). */
  myRoles: string[];
}

/** Current residents of a unit: names and roles only, no contact details. */
export interface UnitResidentsRecord {
  owners: {
    personId: string;
    fullName: string;
    shareNumerator: number;
    shareDenominator: number;
    since: string;
  }[];
  tenants: {
    personId: string;
    fullName: string;
    isPrimary: boolean;
    since: string;
    until: string | null;
  }[];
  household: { personId: string; fullName: string; relationship: string; since: string }[];
}

/**
 * Read model for residents. "Current" always means today in the property's time zone, computed
 * in the database (app_resident_grants and the same date rule for listings).
 */
export interface ResidentsRepository {
  myUnits(organisationId: string, userId: string): Promise<MyUnitRecord[]>;
  unitDetail(
    organisationId: string,
    propertyId: string,
    unitId: string,
    userId: string,
  ): Promise<UnitDetailRecord | null>;
  unitResidents(
    organisationId: string,
    propertyId: string,
    unitId: string,
    userId: string,
  ): Promise<UnitResidentsRecord>;
}
export const RESIDENTS_REPOSITORY = Symbol('RESIDENTS_REPOSITORY');

@Injectable()
export class ResidentsService {
  constructor(@Inject(RESIDENTS_REPOSITORY) private readonly repository: ResidentsRepository) {}

  /** Units on which the caller is owner, tenant or household member today. */
  myUnits(access: OrganisationAccess): Promise<MyUnitRecord[]> {
    return this.repository.myUnits(access.organisationId, access.userId);
  }

  async unit(access: OrganisationAccess): Promise<UnitDetailRecord> {
    const { propertyId, unitId } = this.unitScope(access);
    const unit = await this.repository.unitDetail(
      access.organisationId,
      propertyId,
      unitId,
      access.userId,
    );
    if (!unit) throw new ApiError(404, 'NOT_FOUND', 'Not found');
    return unit;
  }

  residents(access: OrganisationAccess): Promise<UnitResidentsRecord> {
    const { propertyId, unitId } = this.unitScope(access);
    return this.repository.unitResidents(access.organisationId, propertyId, unitId, access.userId);
  }

  private unitScope(access: OrganisationAccess): { propertyId: string; unitId: string } {
    if (!access.propertyId || !access.unitId) throw new Error('Unit route without a resolved unit');
    return { propertyId: access.propertyId, unitId: access.unitId };
  }
}

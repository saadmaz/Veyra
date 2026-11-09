import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type {
  MyUnitRecord,
  ResidentsRepository,
  UnitDetailRecord,
  UnitResidentsRecord,
} from '../application/residents.service';

const isoDate = (value: Date | null): string | null =>
  value ? value.toISOString().slice(0, 10) : null;

/**
 * Residents read model. Every query runs in the organisation's RLS context and filters by
 * organisation and property explicitly. "Today" is the property's local date, computed in SQL.
 */
@Injectable()
export class PrismaResidentsRepository implements ResidentsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  myUnits(organisationId: string, userId: string): Promise<MyUnitRecord[]> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      async (tx) => {
        const rows = await tx.$queryRaw<
          {
            role: string;
            unit_id: string;
            number: string;
            type: string;
            property_id: string;
            property_name: string;
            building_name: string | null;
          }[]
        >`
          SELECT g."role", u."id" AS unit_id, u."number", u."type"::text AS type,
                 p."id" AS property_id, p."name" AS property_name, b."name" AS building_name
            FROM app_resident_grants(${userId}::uuid) g
            JOIN "units" u ON u."id" = g."unit_id" AND u."organisation_id" = ${organisationId}::uuid
            JOIN "properties" p ON p."id" = u."property_id"
            LEFT JOIN "buildings" b ON b."id" = u."building_id"
           ORDER BY p."name", u."number"`;
        const byUnit = new Map<string, MyUnitRecord>();
        for (const row of rows) {
          const existing = byUnit.get(row.unit_id);
          if (existing) {
            existing.roles = [...new Set([...existing.roles, row.role])].sort();
            continue;
          }
          byUnit.set(row.unit_id, {
            unitId: row.unit_id,
            unitNumber: row.number,
            unitType: row.type,
            propertyId: row.property_id,
            propertyName: row.property_name,
            buildingName: row.building_name,
            roles: [row.role],
          });
        }
        return [...byUnit.values()];
      },
      { userId },
    );
  }

  unitDetail(
    organisationId: string,
    propertyId: string,
    unitId: string,
    userId: string,
  ): Promise<UnitDetailRecord | null> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      async (tx) => {
        const unit = await tx.unit.findFirst({
          where: { id: unitId, propertyId, organisationId },
          select: {
            id: true,
            number: true,
            type: true,
            status: true,
            areaSqm: true,
            property: { select: { id: true, name: true } },
            building: { select: { name: true } },
            floor: { select: { name: true } },
          },
        });
        if (!unit) return null;
        const roles = await tx.$queryRaw<{ role: string }[]>`
          SELECT DISTINCT "role" FROM app_resident_grants(${userId}::uuid) WHERE "unit_id" = ${unitId}::uuid`;
        return {
          unitId: unit.id,
          unitNumber: unit.number,
          unitType: unit.type,
          status: unit.status,
          areaSqm: unit.areaSqm ? unit.areaSqm.toFixed(2) : null,
          propertyId: unit.property.id,
          propertyName: unit.property.name,
          buildingName: unit.building?.name ?? null,
          floorName: unit.floor?.name ?? null,
          myRoles: roles.map((r) => r.role).sort(),
        };
      },
      { userId },
    );
  }

  unitResidents(
    organisationId: string,
    propertyId: string,
    unitId: string,
    userId: string,
  ): Promise<UnitResidentsRecord> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      async (tx) => {
        const [today] = await tx.$queryRaw<{ d: Date }[]>`
          SELECT (now() AT TIME ZONE "time_zone")::date AS d
            FROM "properties" WHERE "id" = ${propertyId}::uuid AND "organisation_id" = ${organisationId}::uuid`;
        if (!today) return { owners: [], tenants: [], household: [] };
        const d = today.d;
        const scope = { organisationId, propertyId, unitId };

        const owners = await tx.ownership.findMany({
          where: {
            ...scope,
            voidedAt: null,
            effectiveFrom: { lte: d },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: d } }],
          },
          select: {
            shareNumerator: true,
            shareDenominator: true,
            effectiveFrom: true,
            person: { select: { id: true, fullName: true } },
          },
          orderBy: { effectiveFrom: 'asc' },
        });
        const tenancy = await tx.tenancy.findFirst({
          where: {
            ...scope,
            voidedAt: null,
            startDate: { lte: d },
            OR: [{ endDate: null }, { endDate: { gte: d } }],
          },
          select: {
            startDate: true,
            endDate: true,
            occupants: {
              select: { isPrimary: true, person: { select: { id: true, fullName: true } } },
              orderBy: { isPrimary: 'desc' },
            },
          },
        });
        const household = await tx.householdMember.findMany({
          where: {
            ...scope,
            voidedAt: null,
            validFrom: { lte: d },
            OR: [{ validTo: null }, { validTo: { gte: d } }],
          },
          select: {
            relationship: true,
            validFrom: true,
            person: { select: { id: true, fullName: true } },
          },
          orderBy: { validFrom: 'asc' },
        });

        return {
          owners: owners.map((o) => ({
            personId: o.person.id,
            fullName: o.person.fullName,
            shareNumerator: o.shareNumerator,
            shareDenominator: o.shareDenominator,
            since: isoDate(o.effectiveFrom) as string,
          })),
          tenants: (tenancy?.occupants ?? []).map((occupant) => ({
            personId: occupant.person.id,
            fullName: occupant.person.fullName,
            isPrimary: occupant.isPrimary,
            since: isoDate(tenancy?.startDate ?? null) as string,
            until: isoDate(tenancy?.endDate ?? null),
          })),
          household: household.map((h) => ({
            personId: h.person.id,
            fullName: h.person.fullName,
            relationship: h.relationship,
            since: isoDate(h.validFrom) as string,
          })),
        };
      },
      { userId },
    );
  }
}

import { Inject, Injectable } from '@nestjs/common';
import {
  type DbClient,
  type DbTransaction,
  isUniqueViolation,
  withTenantTransaction,
} from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import {
  type EmergencyContactRecord,
  type HouseholdRecord,
  type IsoDate,
  type OwnershipRecord,
  type Page,
  type PersonRecord,
  type PropertyResidentRecord,
  type ResidentAuditEvent,
  ResidentConflictError,
  type ResidentsStaffRepository,
  type ResidentsUnitOfWork,
  type TenancyRecord,
  type VehicleRecord,
} from '../application/staff-ports';
import type {
  AddEmergencyContactInput,
  AddVehicleInput,
  CreatePersonInput,
  UpdatePersonInput,
} from '../domain/resident-rules';

/** DATE columns travel as UTC-midnight Date values (the session time zone is UTC). */
const toDate = (date: IsoDate) => new Date(`${date}T00:00:00Z`);
const toIso = (date: Date) => date.toISOString().slice(0, 10);
const toIsoOrNull = (date: Date | null) => (date ? toIso(date) : null);
const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

const PERSON_SELECT = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  preferredLanguage: true,
  status: true,
  userId: true,
  createdAt: true,
} as const;

type PersonRow = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  preferredLanguage: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  userId: string | null;
  createdAt: Date;
};

const toPerson = ({ userId, ...row }: PersonRow): PersonRecord => ({
  ...row,
  linked: userId !== null,
});

const VEHICLE_SELECT = {
  id: true,
  plate: true,
  make: true,
  model: true,
  colour: true,
  unitId: true,
  personId: true,
  status: true,
} as const;

class PrismaResidentsUnitOfWork implements ResidentsUnitOfWork {
  constructor(
    private readonly tx: DbTransaction,
    private readonly organisationId: string,
    private readonly propertyId: string | null,
    private readonly userId: string,
    private readonly meta: RequestMeta,
  ) {}

  private get property(): string {
    if (!this.propertyId) throw new Error('Property-scoped operation outside a property');
    return this.propertyId;
  }

  private get unitScope() {
    return { organisationId: this.organisationId, propertyId: this.property };
  }

  async localToday(): Promise<IsoDate> {
    const [row] = await this.tx.$queryRaw<{ d: Date }[]>`
      SELECT (now() AT TIME ZONE "time_zone")::date AS d FROM "properties"
       WHERE "id" = ${this.property}::uuid AND "organisation_id" = ${this.organisationId}::uuid`;
    if (!row) throw new Error('Property not found in tenant context');
    return toIso(row.d);
  }

  async lockUnit(unitId: string) {
    const rows = await this.tx.$queryRaw<
      { id: string; number: string; status: 'ACTIVE' | 'ARCHIVED' }[]
    >`
      SELECT "id", "number", "status"::text AS "status" FROM "units"
       WHERE "id" = ${unitId}::uuid AND "organisation_id" = ${this.organisationId}::uuid
         AND "property_id" = ${this.property}::uuid
       FOR NO KEY UPDATE`;
    return rows[0] ?? null;
  }

  // ---------------------------------------------------------------------------- people

  async getPerson(personId: string): Promise<PersonRecord | null> {
    const row = await this.tx.person.findFirst({
      where: { id: personId, organisationId: this.organisationId },
      select: PERSON_SELECT,
    });
    return row ? toPerson(row) : null;
  }

  async isRelatedToProperty(personId: string): Promise<boolean> {
    const [row] = await this.tx.$queryRaw<{ related: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM "ownerships" WHERE "person_id" = ${personId}::uuid AND "property_id" = ${this.property}::uuid)
          OR EXISTS (SELECT 1 FROM "household_members" WHERE "person_id" = ${personId}::uuid AND "property_id" = ${this.property}::uuid)
          OR EXISTS (SELECT 1 FROM "tenancy_occupants" o JOIN "tenancies" t ON t."id" = o."tenancy_id"
                      WHERE o."person_id" = ${personId}::uuid AND t."property_id" = ${this.property}::uuid)
          OR EXISTS (SELECT 1 FROM "vehicles" WHERE "person_id" = ${personId}::uuid AND "property_id" = ${this.property}::uuid)
         AS related`;
    return row?.related === true;
  }

  async hasNoRecords(personId: string): Promise<boolean> {
    const [row] = await this.tx.$queryRaw<{ none: boolean }[]>`
      SELECT NOT (
           EXISTS (SELECT 1 FROM "ownerships" WHERE "person_id" = ${personId}::uuid)
        OR EXISTS (SELECT 1 FROM "household_members" WHERE "person_id" = ${personId}::uuid)
        OR EXISTS (SELECT 1 FROM "tenancy_occupants" WHERE "person_id" = ${personId}::uuid)
        OR EXISTS (SELECT 1 FROM "vehicles" WHERE "person_id" = ${personId}::uuid)
      ) AS none`;
    return row?.none === true;
  }

  async createPerson(input: CreatePersonInput): Promise<PersonRecord> {
    try {
      const row = await this.tx.person.create({
        data: {
          organisationId: this.organisationId,
          fullName: input.fullName,
          email: input.email ?? null,
          phone: input.phone ?? null,
          preferredLanguage: input.preferredLanguage ?? null,
        },
        select: PERSON_SELECT,
      });
      return toPerson(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ResidentConflictError('PERSON_EMAIL_TAKEN');
      throw error;
    }
  }

  async updatePerson(personId: string, patch: UpdatePersonInput): Promise<PersonRecord> {
    try {
      const row = await this.tx.person.update({
        where: { id: personId },
        data: patch,
        select: PERSON_SELECT,
      });
      return toPerson(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ResidentConflictError('PERSON_EMAIL_TAKEN');
      throw error;
    }
  }

  async listPropertyResidents(today: IsoDate): Promise<PropertyResidentRecord[]> {
    const rows = await this.tx.$queryRaw<
      { person_id: string; unit_id: string; unit_number: string; role: string }[]
    >`
      SELECT o."person_id", o."unit_id", u."number" AS unit_number, 'OWNER' AS role
        FROM "ownerships" o JOIN "units" u ON u."id" = o."unit_id"
       WHERE o."property_id" = ${this.property}::uuid AND o."voided_at" IS NULL
         AND o."effective_from" <= ${today}::date AND (o."effective_to" IS NULL OR o."effective_to" >= ${today}::date)
      UNION
      SELECT oc."person_id", t."unit_id", u."number", 'TENANT'
        FROM "tenancy_occupants" oc JOIN "tenancies" t ON t."id" = oc."tenancy_id" JOIN "units" u ON u."id" = t."unit_id"
       WHERE t."property_id" = ${this.property}::uuid AND t."voided_at" IS NULL
         AND t."start_date" <= ${today}::date AND (t."end_date" IS NULL OR t."end_date" >= ${today}::date)
      UNION
      SELECT h."person_id", h."unit_id", u."number", 'HOUSEHOLD_MEMBER'
        FROM "household_members" h JOIN "units" u ON u."id" = h."unit_id"
       WHERE h."property_id" = ${this.property}::uuid AND h."voided_at" IS NULL
         AND h."valid_from" <= ${today}::date AND (h."valid_to" IS NULL OR h."valid_to" >= ${today}::date)`;
    const personIds = [...new Set(rows.map((r) => r.person_id))];
    const people = await this.tx.person.findMany({
      where: { organisationId: this.organisationId, id: { in: personIds } },
      select: PERSON_SELECT,
      orderBy: { fullName: 'asc' },
    });
    return people.map((person) => {
      const units = new Map<string, { unitId: string; unitNumber: string; roles: string[] }>();
      for (const row of rows.filter((r) => r.person_id === person.id)) {
        const entry = units.get(row.unit_id) ?? {
          unitId: row.unit_id,
          unitNumber: row.unit_number,
          roles: [],
        };
        entry.roles = [...new Set([...entry.roles, row.role])].sort();
        units.set(row.unit_id, entry);
      }
      return { person: toPerson(person), units: [...units.values()] };
    });
  }

  async personRecordsInProperty(personId: string) {
    const ownerships = (await this.allOwnerships({ personId })).filter(
      (o) => o.unitPropertyId === this.property,
    );
    const tenancies = (await this.allTenancies({ occupants: { some: { personId } } })).filter(
      (t) => t.unitPropertyId === this.property,
    );
    const household = (await this.allHousehold({ personId })).filter(
      (h) => h.unitPropertyId === this.property,
    );
    const strip = <T extends { unitPropertyId: string }>({ unitPropertyId: _p, ...rest }: T) =>
      rest;
    return {
      ownerships: ownerships.map(strip),
      tenancies: tenancies.map(strip),
      household: household.map(strip),
    };
  }

  // ---------------------------------------------------------------------------- ownership

  private async allOwnerships(where: { unitId?: string; personId?: string }) {
    const rows = await this.tx.ownership.findMany({
      where: { organisationId: this.organisationId, ...where },
      select: {
        id: true,
        unitId: true,
        propertyId: true,
        personId: true,
        shareNumerator: true,
        shareDenominator: true,
        effectiveFrom: true,
        effectiveTo: true,
        voidedAt: true,
        voidReason: true,
        person: { select: { fullName: true } },
      },
      orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
    });
    return rows.map((o) => ({
      id: o.id,
      unitId: o.unitId,
      unitPropertyId: o.propertyId,
      personId: o.personId,
      fullName: o.person.fullName,
      shareNumerator: o.shareNumerator,
      shareDenominator: o.shareDenominator,
      effectiveFrom: toIso(o.effectiveFrom),
      effectiveTo: toIsoOrNull(o.effectiveTo),
      voidedAt: o.voidedAt,
      voidReason: o.voidReason,
    }));
  }

  async listOwnerships(unitId: string): Promise<OwnershipRecord[]> {
    return (await this.allOwnerships({ unitId })).map(({ unitPropertyId: _p, ...rest }) => rest);
  }

  async createOwnership(
    unitId: string,
    owner: { personId: string; shareNumerator: number; shareDenominator: number },
    from: IsoDate,
  ): Promise<string> {
    const row = await this.tx.ownership.create({
      data: { ...this.unitScope, unitId, ...owner, effectiveFrom: toDate(from) },
      select: { id: true },
    });
    return row.id;
  }

  async setOwnershipEnd(ownershipId: string, to: IsoDate): Promise<void> {
    await this.tx.ownership.update({
      where: { id: ownershipId },
      data: { effectiveTo: toDate(to) },
    });
  }

  async voidOwnership(ownershipId: string, reason: string, at: Date): Promise<void> {
    await this.tx.ownership.update({
      where: { id: ownershipId },
      data: { voidedAt: at, voidReason: reason },
    });
  }

  // ---------------------------------------------------------------------------- tenancies

  private async allTenancies(where: Record<string, unknown>) {
    const rows = await this.tx.tenancy.findMany({
      where: { organisationId: this.organisationId, ...where },
      select: {
        id: true,
        unitId: true,
        propertyId: true,
        startDate: true,
        endDate: true,
        voidedAt: true,
        voidReason: true,
        occupants: {
          select: { personId: true, isPrimary: true, person: { select: { fullName: true } } },
          orderBy: { isPrimary: 'desc' },
        },
      },
      orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
    });
    return rows.map((t) => ({
      id: t.id,
      unitId: t.unitId,
      unitPropertyId: t.propertyId,
      startDate: toIso(t.startDate),
      endDate: toIsoOrNull(t.endDate),
      voidedAt: t.voidedAt,
      voidReason: t.voidReason,
      occupants: t.occupants.map((o) => ({
        personId: o.personId,
        fullName: o.person.fullName,
        isPrimary: o.isPrimary,
      })),
    }));
  }

  async listTenancies(unitId: string): Promise<TenancyRecord[]> {
    return (await this.allTenancies({ unitId })).map(({ unitPropertyId: _p, ...rest }) => rest);
  }

  async createTenancy(
    unitId: string,
    startDate: IsoDate,
    endDate: IsoDate | null,
    occupants: { personId: string; isPrimary: boolean }[],
  ): Promise<string> {
    const tenancy = await this.tx.tenancy.create({
      data: {
        ...this.unitScope,
        unitId,
        startDate: toDate(startDate),
        endDate: endDate ? toDate(endDate) : null,
      },
      select: { id: true },
    });
    await this.tx.tenancyOccupant.createMany({
      data: occupants.map((o) => ({
        organisationId: this.organisationId,
        tenancyId: tenancy.id,
        ...o,
      })),
    });
    return tenancy.id;
  }

  async setTenancyEnd(tenancyId: string, endDate: IsoDate): Promise<void> {
    await this.tx.tenancy.update({ where: { id: tenancyId }, data: { endDate: toDate(endDate) } });
  }

  async voidTenancy(tenancyId: string, reason: string, at: Date): Promise<void> {
    await this.tx.tenancy.update({
      where: { id: tenancyId },
      data: { voidedAt: at, voidReason: reason },
    });
  }

  // ---------------------------------------------------------------------------- household

  private async allHousehold(where: { unitId?: string; personId?: string }) {
    const rows = await this.tx.householdMember.findMany({
      where: { organisationId: this.organisationId, ...where },
      select: {
        id: true,
        unitId: true,
        propertyId: true,
        personId: true,
        relationship: true,
        validFrom: true,
        validTo: true,
        voidedAt: true,
        person: { select: { fullName: true } },
      },
      orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
    });
    return rows.map((h) => ({
      id: h.id,
      unitId: h.unitId,
      unitPropertyId: h.propertyId,
      personId: h.personId,
      fullName: h.person.fullName,
      relationship: h.relationship,
      validFrom: toIso(h.validFrom),
      validTo: toIsoOrNull(h.validTo),
      voidedAt: h.voidedAt,
    }));
  }

  async listHousehold(unitId: string): Promise<HouseholdRecord[]> {
    return (await this.allHousehold({ unitId })).map(({ unitPropertyId: _p, ...rest }) => rest);
  }

  async addHouseholdMember(
    unitId: string,
    input: { personId: string; relationship: string; validFrom: IsoDate; validTo: IsoDate | null },
  ): Promise<string> {
    const row = await this.tx.householdMember.create({
      data: {
        ...this.unitScope,
        unitId,
        personId: input.personId,
        relationship: input.relationship as never,
        validFrom: toDate(input.validFrom),
        validTo: input.validTo ? toDate(input.validTo) : null,
      },
      select: { id: true },
    });
    return row.id;
  }

  async setHouseholdEnd(memberId: string, validTo: IsoDate): Promise<void> {
    await this.tx.householdMember.update({
      where: { id: memberId },
      data: { validTo: toDate(validTo) },
    });
  }

  async voidHouseholdMember(memberId: string, at: Date): Promise<void> {
    await this.tx.householdMember.update({ where: { id: memberId }, data: { voidedAt: at } });
  }

  // ---------------------------------------------------------------------------- vehicles

  listVehicles(status: 'ACTIVE' | 'ARCHIVED'): Promise<VehicleRecord[]> {
    return this.tx.vehicle.findMany({
      where: { organisationId: this.organisationId, propertyId: this.property, status },
      select: VEHICLE_SELECT,
      orderBy: { plate: 'asc' },
    });
  }

  async addVehicle(input: AddVehicleInput): Promise<VehicleRecord> {
    try {
      return await this.tx.vehicle.create({
        data: {
          organisationId: this.organisationId,
          propertyId: this.property,
          plate: input.plate,
          make: input.make ?? null,
          model: input.model ?? null,
          colour: input.colour ?? null,
          unitId: input.unitId ?? null,
          personId: input.personId ?? null,
        },
        select: VEHICLE_SELECT,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ResidentConflictError('PLATE_TAKEN');
      throw error;
    }
  }

  getVehicle(vehicleId: string): Promise<VehicleRecord | null> {
    return this.tx.vehicle.findFirst({
      where: { id: vehicleId, organisationId: this.organisationId, propertyId: this.property },
      select: VEHICLE_SELECT,
    });
  }

  archiveVehicle(vehicleId: string, at: Date): Promise<VehicleRecord> {
    return this.tx.vehicle.update({
      where: { id: vehicleId },
      data: { status: 'ARCHIVED', archivedAt: at },
      select: VEHICLE_SELECT,
    });
  }

  // ---------------------------------------------------------------------------- emergency contacts

  listEmergencyContacts(personId: string): Promise<EmergencyContactRecord[]> {
    return this.tx.emergencyContact.findMany({
      where: { organisationId: this.organisationId, personId },
      select: { id: true, name: true, phone: true, relationship: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  addEmergencyContact(
    personId: string,
    input: AddEmergencyContactInput,
  ): Promise<EmergencyContactRecord> {
    return this.tx.emergencyContact.create({
      data: {
        organisationId: this.organisationId,
        personId,
        name: input.name,
        phone: input.phone,
        relationship: input.relationship ?? null,
      },
      select: { id: true, name: true, phone: true, relationship: true },
    });
  }

  async deleteEmergencyContact(personId: string, contactId: string): Promise<boolean> {
    const { count } = await this.tx.emergencyContact.deleteMany({
      where: { id: contactId, personId, organisationId: this.organisationId },
    });
    return count === 1;
  }

  // ---------------------------------------------------------------------------- audit

  async audit(event: ResidentAuditEvent): Promise<void> {
    await this.tx.auditLog.createMany({
      data: [
        {
          organisationId: this.organisationId,
          actorUserId: this.userId,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          metadata: {
            ...(this.propertyId ? { propertyId: this.propertyId } : {}),
            ...(event.metadata ?? {}),
          },
          requestId: clip(this.meta.requestId, 128),
          ipAddress: clip(this.meta.ipAddress, 64),
        },
      ],
    });
  }
}

@Injectable()
export class PrismaResidentsStaffRepository implements ResidentsStaffRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inScope<T>(
    organisationId: string,
    propertyId: string | null,
    userId: string,
    meta: RequestMeta,
    work: (uow: ResidentsUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaResidentsUnitOfWork(tx, organisationId, propertyId, userId, meta)),
      { userId },
    );
  }

  async searchPersons(
    organisationId: string,
    userId: string,
    query: string | undefined,
    page: { limit: number; cursor?: string | undefined },
  ): Promise<Page<PersonRecord>> {
    const rows = await withTenantTransaction(
      this.db,
      { organisationId },
      (tx) =>
        tx.person.findMany({
          where: {
            organisationId,
            ...(query
              ? {
                  OR: [
                    { fullName: { contains: query, mode: 'insensitive' } },
                    { email: { startsWith: query.toLowerCase() } },
                  ],
                }
              : {}),
            ...(page.cursor ? { id: { gt: page.cursor } } : {}),
          },
          select: PERSON_SELECT,
          orderBy: { id: 'asc' },
          take: page.limit + 1,
        }),
      { userId },
    );
    const data = rows.slice(0, page.limit).map(toPerson);
    return { data, nextCursor: rows.length > page.limit ? (data.at(-1)?.id ?? null) : null };
  }
}

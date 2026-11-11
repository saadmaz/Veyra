import { Inject, Injectable } from '@nestjs/common';
import { databaseErrorCode } from '@veyra/db';
import { CLOCK, type Clock } from '../../../platform/clock';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import type { OrganisationAccess } from '../../access-control';
import type {
  AddEmergencyContactInput,
  AddHouseholdMemberInput,
  AddVehicleInput,
  CreatePersonInput,
  CreateTenancyInput,
  SetOwnersInput,
  UpdatePersonInput,
} from '../domain/resident-rules';
import {
  type IsoDate,
  type PersonRecord,
  RESIDENTS_STAFF_REPOSITORY,
  ResidentConflictError,
  type ResidentsStaffRepository,
  type ResidentsUnitOfWork,
} from './staff-ports';

const CONFLICT_MESSAGES: Record<string, string> = {
  PERSON_EMAIL_TAKEN: 'Another resident in this organisation already uses this email address',
  PLATE_TAKEN: 'An active vehicle with this plate is already registered at this property',
};

/** The day before a calendar date (YYYY-MM-DD). */
export function dayBefore(date: IsoDate): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Inclusive periods [aFrom, aTo] and [bFrom, bTo] (null = open-ended) overlap. */
export function periodsOverlap(
  aFrom: IsoDate,
  aTo: IsoDate | null,
  bFrom: IsoDate,
  bTo: IsoDate | null,
): boolean {
  return (aTo === null || aTo >= bFrom) && (bTo === null || bTo >= aFrom);
}

const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);

/**
 * Staff management of residents: profiles, ownership, tenancies, household members, vehicles
 * and emergency contacts. Every change to a unit's residents locks the unit row first, so
 * changes to one unit, and archiving it, run one at a time; the rules below are therefore
 * checked against a stable state. The database constraints remain as a backstop.
 */
@Injectable()
export class ResidentsStaffService {
  constructor(
    @Inject(RESIDENTS_STAFF_REPOSITORY) private readonly repository: ResidentsStaffRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------------------ people

  searchPersons(
    access: OrganisationAccess,
    query: string | undefined,
    page: { limit: number; cursor?: string | undefined },
  ) {
    return this.repository.searchPersons(access.organisationId, access.userId, query, page);
  }

  /** Organisation-level detail (directory). */
  personInOrganisation(access: OrganisationAccess, personId: string, meta: RequestMeta) {
    return this.inOrganisation(access, meta, async (uow) => {
      const person = await uow.getPerson(personId);
      if (!person) throw notFound('Resident');
      return { person, emergencyContacts: await uow.listEmergencyContacts(personId) };
    });
  }

  createPerson(access: OrganisationAccess, input: CreatePersonInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const person = await uow.createPerson(input);
      await uow.audit({ action: 'person.created', resourceType: 'person', resourceId: person.id });
      return person;
    });
  }

  /** People property staff can choose in forms (same visibility as the profile page). */
  listSelectablePersons(access: OrganisationAccess, query: string | undefined, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => uow.listSelectablePersons(query));
  }

  listPropertyResidents(access: OrganisationAccess, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) =>
      uow.listPropertyResidents(await uow.localToday()),
    );
  }

  personInProperty(access: OrganisationAccess, personId: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const person = await this.visiblePerson(uow, personId);
      return {
        person,
        ...(await uow.personRecordsInProperty(personId)),
        emergencyContacts: await uow.listEmergencyContacts(personId),
      };
    });
  }

  updatePerson(
    access: OrganisationAccess,
    personId: string,
    input: UpdatePersonInput,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      const person = await this.visiblePerson(uow, personId);
      if (person.status === 'ARCHIVED')
        throw new ApiError(409, 'ARCHIVED', 'This resident profile is archived');
      const updated = await uow.updatePerson(personId, input);
      await uow.audit({
        action: 'person.updated',
        resourceType: 'person',
        resourceId: personId,
        metadata: { fields: Object.keys(input).sort().join(',') },
      });
      return updated;
    });
  }

  addEmergencyContact(
    access: OrganisationAccess,
    personId: string,
    input: AddEmergencyContactInput,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      await this.visiblePerson(uow, personId);
      const contact = await uow.addEmergencyContact(personId, input);
      await uow.audit({
        action: 'emergency_contact.added',
        resourceType: 'person',
        resourceId: personId,
      });
      return contact;
    });
  }

  removeEmergencyContact(
    access: OrganisationAccess,
    personId: string,
    contactId: string,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      await this.visiblePerson(uow, personId);
      if (!(await uow.deleteEmergencyContact(personId, contactId)))
        throw notFound('Emergency contact');
      await uow.audit({
        action: 'emergency_contact.removed',
        resourceType: 'person',
        resourceId: personId,
      });
    });
  }

  // ------------------------------------------------------------------------------ ownership

  listOwnerships(access: OrganisationAccess, unitId: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      if (!(await uow.lockUnit(unitId))) throw notFound('Unit');
      return uow.listOwnerships(unitId);
    });
  }

  /**
   * Sets the owners of a unit from a date. Owners whose ownership covers that date end the day
   * before; the new owners start on it. Shares were validated as exact fractions summing to one,
   * and the database re-checks every date at commit. Refused when an ownership already starts
   * on or after the date (void it first), so history is never silently rewritten.
   */
  setOwners(access: OrganisationAccess, unitId: string, input: SetOwnersInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      await this.activeUnit(uow, unitId);
      for (const owner of input.owners) await this.activePerson(uow, owner.personId);

      const current = (await uow.listOwnerships(unitId)).filter((o) => o.voidedAt === null);
      if (current.some((o) => o.effectiveFrom >= input.effectiveFrom)) {
        throw new ApiError(
          409,
          'OWNERSHIP_CONFLICT',
          'An ownership already starts on or after this date. Void it first if it was a mistake.',
        );
      }
      const previousDay = dayBefore(input.effectiveFrom);
      for (const o of current) {
        if (o.effectiveTo === null || o.effectiveTo >= input.effectiveFrom)
          await uow.setOwnershipEnd(o.id, previousDay);
      }
      for (const owner of input.owners)
        await uow.createOwnership(unitId, owner, input.effectiveFrom);
      await uow.audit({
        action: 'ownership.set',
        resourceType: 'unit',
        resourceId: unitId,
        metadata: { effectiveFrom: input.effectiveFrom, owners: input.owners.length },
      });
      return uow.listOwnerships(unitId);
    });
  }

  /** Voids mistaken ownerships. The remaining owners must still add up to one on every date. */
  voidOwnerships(
    access: OrganisationAccess,
    unitId: string,
    ids: string[],
    reason: string,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      if (!(await uow.lockUnit(unitId))) throw notFound('Unit');
      const ownerships = await uow.listOwnerships(unitId);
      const now = this.clock.now();
      for (const id of ids) {
        const ownership = ownerships.find((o) => o.id === id);
        if (!ownership) throw notFound('Ownership');
        if (ownership.voidedAt) continue;
        await uow.voidOwnership(id, reason, now);
      }
      await uow.audit({
        action: 'ownership.voided',
        resourceType: 'unit',
        resourceId: unitId,
        metadata: { count: ids.length },
      });
      return uow.listOwnerships(unitId);
    });
  }

  // ------------------------------------------------------------------------------ tenancies

  listTenancies(access: OrganisationAccess, unitId: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      if (!(await uow.lockUnit(unitId))) throw notFound('Unit');
      return uow.listTenancies(unitId);
    });
  }

  /** Move-in: one tenancy per unit at a time, exactly one primary tenant. */
  createTenancy(
    access: OrganisationAccess,
    unitId: string,
    input: CreateTenancyInput,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      await this.activeUnit(uow, unitId);
      for (const occupant of input.occupants) await this.activePerson(uow, occupant.personId);
      const endDate = input.endDate ?? null;
      const clash = (await uow.listTenancies(unitId)).find(
        (t) =>
          t.voidedAt === null && periodsOverlap(t.startDate, t.endDate, input.startDate, endDate),
      );
      if (clash)
        throw new ApiError(
          409,
          'TENANCY_OVERLAP',
          'This unit already has a tenancy in that period',
        );
      const id = await uow.createTenancy(unitId, input.startDate, endDate, input.occupants);
      await uow.audit({
        action: 'tenancy.created',
        resourceType: 'tenancy',
        resourceId: id,
        metadata: { unitId, startDate: input.startDate },
      });
      return (await uow.listTenancies(unitId)).find((t) => t.id === id);
    });
  }

  /** Move-out: sets the last day. Cannot run into a later tenancy. */
  endTenancy(
    access: OrganisationAccess,
    unitId: string,
    tenancyId: string,
    endDate: IsoDate,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      if (!(await uow.lockUnit(unitId))) throw notFound('Unit');
      const tenancies = await uow.listTenancies(unitId);
      const tenancy = tenancies.find((t) => t.id === tenancyId);
      if (!tenancy) throw notFound('Tenancy');
      if (tenancy.voidedAt) throw new ApiError(409, 'VOIDED', 'This tenancy was voided');
      if (endDate < tenancy.startDate)
        throw new ApiError(422, 'INVALID_PERIOD', 'The end date cannot be before the start date');
      const clash = tenancies.find(
        (t) =>
          t.id !== tenancyId &&
          t.voidedAt === null &&
          periodsOverlap(t.startDate, t.endDate, tenancy.startDate, endDate),
      );
      if (clash)
        throw new ApiError(409, 'TENANCY_OVERLAP', 'That end date runs into another tenancy');
      await uow.setTenancyEnd(tenancyId, endDate);
      await uow.audit({
        action: 'tenancy.ended',
        resourceType: 'tenancy',
        resourceId: tenancyId,
        metadata: { endDate },
      });
      return (await uow.listTenancies(unitId)).find((t) => t.id === tenancyId);
    });
  }

  voidTenancy(
    access: OrganisationAccess,
    unitId: string,
    tenancyId: string,
    reason: string,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      if (!(await uow.lockUnit(unitId))) throw notFound('Unit');
      const tenancy = (await uow.listTenancies(unitId)).find((t) => t.id === tenancyId);
      if (!tenancy) throw notFound('Tenancy');
      if (!tenancy.voidedAt) {
        await uow.voidTenancy(tenancyId, reason, this.clock.now());
        await uow.audit({
          action: 'tenancy.voided',
          resourceType: 'tenancy',
          resourceId: tenancyId,
        });
      }
      return (await uow.listTenancies(unitId)).find((t) => t.id === tenancyId);
    });
  }

  // ------------------------------------------------------------------------------ household

  listHousehold(access: OrganisationAccess, unitId: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      if (!(await uow.lockUnit(unitId))) throw notFound('Unit');
      return uow.listHousehold(unitId);
    });
  }

  addHouseholdMember(
    access: OrganisationAccess,
    unitId: string,
    input: AddHouseholdMemberInput,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      await this.activeUnit(uow, unitId);
      await this.activePerson(uow, input.personId);
      const validTo = input.validTo ?? null;
      const clash = (await uow.listHousehold(unitId)).find(
        (h) =>
          h.voidedAt === null &&
          h.personId === input.personId &&
          periodsOverlap(h.validFrom, h.validTo, input.validFrom, validTo),
      );
      if (clash)
        throw new ApiError(
          409,
          'HOUSEHOLD_OVERLAP',
          'This person is already in the household for that period',
        );
      const id = await uow.addHouseholdMember(unitId, { ...input, validTo });
      await uow.audit({
        action: 'household.added',
        resourceType: 'household_member',
        resourceId: id,
        metadata: { unitId },
      });
      return (await uow.listHousehold(unitId)).find((h) => h.id === id);
    });
  }

  endHouseholdMember(
    access: OrganisationAccess,
    unitId: string,
    memberId: string,
    endDate: IsoDate,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      if (!(await uow.lockUnit(unitId))) throw notFound('Unit');
      const household = await uow.listHousehold(unitId);
      const member = household.find((h) => h.id === memberId);
      if (!member) throw notFound('Household member');
      if (member.voidedAt) throw new ApiError(409, 'VOIDED', 'This record was voided');
      if (endDate < member.validFrom)
        throw new ApiError(422, 'INVALID_PERIOD', 'The end date cannot be before the start date');
      const clash = household.find(
        (h) =>
          h.id !== memberId &&
          h.voidedAt === null &&
          h.personId === member.personId &&
          periodsOverlap(h.validFrom, h.validTo, member.validFrom, endDate),
      );
      if (clash)
        throw new ApiError(
          409,
          'HOUSEHOLD_OVERLAP',
          'That end date runs into another period for this person',
        );
      await uow.setHouseholdEnd(memberId, endDate);
      await uow.audit({
        action: 'household.ended',
        resourceType: 'household_member',
        resourceId: memberId,
        metadata: { endDate },
      });
      return (await uow.listHousehold(unitId)).find((h) => h.id === memberId);
    });
  }

  voidHouseholdMember(
    access: OrganisationAccess,
    unitId: string,
    memberId: string,
    meta: RequestMeta,
  ) {
    return this.inProperty(access, meta, async (uow) => {
      if (!(await uow.lockUnit(unitId))) throw notFound('Unit');
      const member = (await uow.listHousehold(unitId)).find((h) => h.id === memberId);
      if (!member) throw notFound('Household member');
      if (!member.voidedAt) {
        await uow.voidHouseholdMember(memberId, this.clock.now());
        await uow.audit({
          action: 'household.voided',
          resourceType: 'household_member',
          resourceId: memberId,
        });
      }
      return (await uow.listHousehold(unitId)).find((h) => h.id === memberId);
    });
  }

  // ------------------------------------------------------------------------------ vehicles

  listVehicles(access: OrganisationAccess, status: 'ACTIVE' | 'ARCHIVED', meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => uow.listVehicles(status));
  }

  addVehicle(access: OrganisationAccess, input: AddVehicleInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      if (input.unitId) await this.activeUnit(uow, input.unitId);
      if (input.personId) await this.activePerson(uow, input.personId);
      const vehicle = await uow.addVehicle(input);
      await uow.audit({
        action: 'vehicle.added',
        resourceType: 'vehicle',
        resourceId: vehicle.id,
        metadata: { plate: vehicle.plate },
      });
      return vehicle;
    });
  }

  archiveVehicle(access: OrganisationAccess, vehicleId: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const vehicle = await uow.getVehicle(vehicleId);
      if (!vehicle) throw notFound('Vehicle');
      if (vehicle.status === 'ARCHIVED') return vehicle;
      const archived = await uow.archiveVehicle(vehicleId, this.clock.now());
      await uow.audit({
        action: 'vehicle.archived',
        resourceType: 'vehicle',
        resourceId: vehicleId,
      });
      return archived;
    });
  }

  // ------------------------------------------------------------------------------ helpers

  private inProperty<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: ResidentsUnitOfWork) => Promise<T>,
  ) {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    return this.run(() =>
      this.repository.inScope(
        access.organisationId,
        access.propertyId as string,
        access.userId,
        meta,
        work,
      ),
    );
  }

  private inOrganisation<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: ResidentsUnitOfWork) => Promise<T>,
  ) {
    return this.run(() =>
      this.repository.inScope(access.organisationId, null, access.userId, meta, work),
    );
  }

  /** Maps known conflicts; database constraint violations become 409 instead of 500. */
  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ResidentConflictError) {
        throw new ApiError(409, error.code, CONFLICT_MESSAGES[error.code] ?? 'Conflict');
      }
      const code = databaseErrorCode(error);
      if (code === '23514' || code === '23P01') {
        // The backstop fired: e.g. voiding one co-owner leaves shares that no longer add up.
        throw new ApiError(
          409,
          'RESIDENCY_RULE_VIOLATED',
          'This change would break a residency rule (ownership shares must add up to one, and periods cannot overlap)',
        );
      }
      throw error;
    }
  }

  /**
   * Property staff see a person only if they have a record on one of the property's units, or
   * no records at all yet (just created, about to be attached).
   */
  private async visiblePerson(uow: ResidentsUnitOfWork, personId: string): Promise<PersonRecord> {
    const person = await uow.getPerson(personId);
    if (
      !person ||
      !((await uow.isRelatedToProperty(personId)) || (await uow.hasNoRecords(personId)))
    ) {
      throw notFound('Resident');
    }
    return person;
  }

  private async activeUnit(uow: ResidentsUnitOfWork, unitId: string) {
    const unit = await uow.lockUnit(unitId);
    if (!unit) throw notFound('Unit');
    if (unit.status === 'ARCHIVED') throw new ApiError(409, 'ARCHIVED', 'This unit is archived');
    return unit;
  }

  private async activePerson(uow: ResidentsUnitOfWork, personId: string) {
    const person = await uow.getPerson(personId);
    if (!person) throw notFound('Resident');
    if (person.status === 'ARCHIVED')
      throw new ApiError(409, 'ARCHIVED', 'This resident profile is archived');
    return person;
  }
}

import type { RequestMeta } from '../../../platform/request-meta';
import type {
  AddEmergencyContactInput,
  AddVehicleInput,
  CreatePersonInput,
  UpdatePersonInput,
} from '../domain/resident-rules';

/** Calendar dates are exchanged as YYYY-MM-DD strings (property-local). */
export type IsoDate = string;

export interface PersonRecord {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  preferredLanguage: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  /** True once the profile is linked to a login. */
  linked: boolean;
  createdAt: Date;
}

export interface OwnershipRecord {
  id: string;
  unitId: string;
  personId: string;
  fullName: string;
  shareNumerator: number;
  shareDenominator: number;
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  voidedAt: Date | null;
  voidReason: string | null;
}

export interface TenancyRecord {
  id: string;
  unitId: string;
  startDate: IsoDate;
  endDate: IsoDate | null;
  voidedAt: Date | null;
  voidReason: string | null;
  occupants: { personId: string; fullName: string; isPrimary: boolean }[];
}

export interface HouseholdRecord {
  id: string;
  unitId: string;
  personId: string;
  fullName: string;
  relationship: string;
  validFrom: IsoDate;
  validTo: IsoDate | null;
  voidedAt: Date | null;
}

export interface VehicleRecord {
  id: string;
  plate: string;
  make: string | null;
  model: string | null;
  colour: string | null;
  unitId: string | null;
  personId: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
}

export interface EmergencyContactRecord {
  id: string;
  name: string;
  phone: string;
  relationship: string | null;
}

/** One row of a property's resident list: a person and their current roles per unit. */
export interface PropertyResidentRecord {
  person: PersonRecord;
  units: { unitId: string; unitNumber: string; roles: string[] }[];
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export class ResidentConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface ResidentAuditEvent {
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, string | number | boolean | null>;
}

/**
 * Operations inside one transaction in the organisation's RLS context, for one property. Every
 * query filters by organisation (and property where the table has it). lockUnit takes a
 * FOR NO KEY UPDATE lock, so changes to one unit's residents run one at a time and also wait
 * for, or block, archiving that unit.
 */
export interface ResidentsUnitOfWork {
  /** Today in the property's time zone. */
  localToday(): Promise<IsoDate>;
  /** Locks the unit if it belongs to the property. */
  lockUnit(
    unitId: string,
  ): Promise<{ id: string; number: string; status: 'ACTIVE' | 'ARCHIVED' } | null>;

  getPerson(personId: string): Promise<PersonRecord | null>;
  /** Whether the person has any record (even past or voided) on a unit of this property. */
  isRelatedToProperty(personId: string): Promise<boolean>;
  /** Whether the person has no records anywhere in the organisation (just created). */
  hasNoRecords(personId: string): Promise<boolean>;
  createPerson(input: CreatePersonInput): Promise<PersonRecord>;
  updatePerson(personId: string, patch: UpdatePersonInput): Promise<PersonRecord>;
  listPropertyResidents(today: IsoDate): Promise<PropertyResidentRecord[]>;
  personRecordsInProperty(personId: string): Promise<{
    ownerships: OwnershipRecord[];
    tenancies: TenancyRecord[];
    household: HouseholdRecord[];
  }>;

  listOwnerships(unitId: string): Promise<OwnershipRecord[]>;
  createOwnership(
    unitId: string,
    owner: { personId: string; shareNumerator: number; shareDenominator: number },
    from: IsoDate,
  ): Promise<string>;
  setOwnershipEnd(ownershipId: string, to: IsoDate): Promise<void>;
  voidOwnership(ownershipId: string, reason: string, at: Date): Promise<void>;

  listTenancies(unitId: string): Promise<TenancyRecord[]>;
  createTenancy(
    unitId: string,
    startDate: IsoDate,
    endDate: IsoDate | null,
    occupants: { personId: string; isPrimary: boolean }[],
  ): Promise<string>;
  setTenancyEnd(tenancyId: string, endDate: IsoDate): Promise<void>;
  voidTenancy(tenancyId: string, reason: string, at: Date): Promise<void>;

  listHousehold(unitId: string): Promise<HouseholdRecord[]>;
  addHouseholdMember(
    unitId: string,
    input: { personId: string; relationship: string; validFrom: IsoDate; validTo: IsoDate | null },
  ): Promise<string>;
  setHouseholdEnd(memberId: string, validTo: IsoDate): Promise<void>;
  voidHouseholdMember(memberId: string, at: Date): Promise<void>;

  listVehicles(status: 'ACTIVE' | 'ARCHIVED'): Promise<VehicleRecord[]>;
  addVehicle(input: AddVehicleInput): Promise<VehicleRecord>;
  getVehicle(vehicleId: string): Promise<VehicleRecord | null>;
  archiveVehicle(vehicleId: string, at: Date): Promise<VehicleRecord>;

  listEmergencyContacts(personId: string): Promise<EmergencyContactRecord[]>;
  addEmergencyContact(
    personId: string,
    input: AddEmergencyContactInput,
  ): Promise<EmergencyContactRecord>;
  deleteEmergencyContact(personId: string, contactId: string): Promise<boolean>;

  audit(event: ResidentAuditEvent): Promise<void>;
}

export interface ResidentsStaffRepository {
  /** propertyId null: organisation-level operations (directory search, person detail). */
  inScope<T>(
    organisationId: string,
    propertyId: string | null,
    userId: string,
    meta: RequestMeta,
    work: (uow: ResidentsUnitOfWork) => Promise<T>,
  ): Promise<T>;
  searchPersons(
    organisationId: string,
    userId: string,
    query: string | undefined,
    page: { limit: number; cursor?: string | undefined },
  ): Promise<Page<PersonRecord>>;
}
export const RESIDENTS_STAFF_REPOSITORY = Symbol('RESIDENTS_STAFF_REPOSITORY');

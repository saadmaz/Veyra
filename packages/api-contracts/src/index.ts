/**
 * Wire-level types for the VEYRA REST API (docs/architecture/API_DESIGN.md).
 * Hand-written for platform-wide shapes; per-endpoint types will be generated from the
 * OpenAPI document once business endpoints exist.
 */

export interface ErrorDetail {
  path: string;
  message: string;
}

/** Body of every non-2xx response. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: ErrorDetail[];
    requestId?: string;
  };
}

/** Cursor-paginated list response. */
export interface Paginated<T> {
  data: T[];
  nextCursor: string | null;
}

/** Monetary amount on the wire: minor units as a string so JSON never loses precision. */
export interface MoneyDto {
  amountMinor: string;
  currency: string;
}

export interface LivenessResponse {
  status: 'ok';
}

export interface ReadinessResponse {
  status: 'ok' | 'error';
  checks: Record<string, 'up' | 'down'>;
}

// ---------------------------------------------------------------------------------------------
// Authentication (ADR 0005)
// ---------------------------------------------------------------------------------------------

/** `web` gets an httpOnly cookie; `mobile` gets a bearer token in the response body. */
export type AuthClient = 'web' | 'mobile';

export interface SignUpRequest {
  email: string;
  password: string;
  displayName: string;
  client?: AuthClient;
}

export interface SignInRequest {
  email: string;
  password: string;
  client?: AuthClient;
}

export interface AuthUserDto {
  id: string;
  email: string;
  displayName: string;
}

export interface AuthSessionDto {
  client: AuthClient;
  /** ISO 8601. Extended by activity, never beyond absoluteExpiresAt. */
  idleExpiresAt: string;
  /** ISO 8601. The session ends here regardless of activity. */
  absoluteExpiresAt: string;
}

/** Response of sign-up and sign-in. `token` is present only for `mobile` clients. */
export interface AuthResponse {
  user: AuthUserDto;
  session: AuthSessionDto;
  token?: string;
}

/** Response of GET /auth/session. */
export interface CurrentSessionResponse {
  user: AuthUserDto;
  session: { client: AuthClient };
}

// ---------------------------------------------------------------------------------------------
// Organisations, memberships and invitations (Phase 2, Part 5)
// ---------------------------------------------------------------------------------------------

export type OrganisationStatus =
  | 'PENDING_ONBOARDING'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'OFFBOARDING'
  | 'ARCHIVED';

export interface CreateOrganisationRequest {
  name: string;
  /** Lower-case letters, digits and single hyphens, 3-63 characters. Unique. */
  slug: string;
  /** ISO 3166-1 alpha-2, e.g. "PK". Fixed after creation. */
  countryCode: string;
  /** ISO 4217, e.g. "PKR". Fixed after creation. */
  defaultCurrency: string;
  /** IANA time zone, e.g. "Asia/Karachi". */
  defaultTimeZone: string;
}

export interface UpdateOrganisationRequest {
  name?: string;
  defaultTimeZone?: string;
}

export interface OrganisationDto {
  id: string;
  name: string;
  slug: string;
  countryCode: string;
  defaultCurrency: string;
  defaultTimeZone: string;
  status: OrganisationStatus;
  createdAt: string;
}

/** GET /organisations/:id: the organisation plus what the caller may do in it (for UI only). */
export interface OrganisationDetailResponse extends OrganisationDto {
  permissions: string[];
}

/** An item of GET /organisations (the caller's organisations). */
export interface MyOrganisationDto {
  organisation: OrganisationDto;
  roles: string[];
}

export type MembershipStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED';

export interface MembershipDto {
  id: string;
  userId: string;
  email: string;
  displayName: string;
  role: string;
  scopeType: 'ORGANISATION' | 'PROPERTY' | 'BUILDING' | 'UNIT';
  scopeId: string;
  status: MembershipStatus;
  validFrom: string;
  validUntil: string | null;
}

export interface ChangeMembershipStatusRequest {
  status: MembershipStatus;
}

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export interface CreateInvitationRequest {
  email: string;
  role: string;
  /** Limits the role to one property; omit for an organisation-wide role. */
  propertyId?: string;
}

export interface InvitationDto {
  id: string;
  email: string;
  role: string;
  scopeType: 'ORGANISATION' | 'PROPERTY' | 'BUILDING' | 'UNIT';
  scopeId: string;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
}

/** `token` is shown once. The invitee opens the link and calls POST /invitations/accept. */
export interface CreateInvitationResponse {
  invitation: InvitationDto;
  token: string;
}

export interface AcceptInvitationRequest {
  token: string;
}

export interface AcceptInvitationResponse {
  organisation: OrganisationDto;
  role: string;
}

// ---------------------------------------------------------------------------------------------
// Properties (Phase 3)
// ---------------------------------------------------------------------------------------------

export type PropertyType =
  | 'CONDOMINIUM'
  | 'APARTMENT_COMPLEX'
  | 'GATED_COMMUNITY'
  | 'MIXED_USE'
  | 'OTHER';

export type PropertyStatus = 'ONBOARDING' | 'ACTIVE' | 'ARCHIVED';

export interface CreatePropertyRequest {
  name: string;
  /** Unique in the organisation; upper-case letters, digits and hyphens, 2-20 characters. */
  code: string;
  type: PropertyType;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  region?: string;
  postalCode?: string;
  /** Defaults to the organisation's country. */
  countryCode?: string;
  /** IANA time zone; defaults to the organisation's. */
  timeZone?: string;
  /** ISO 4217; defaults to the organisation's. */
  currency?: string;
}

export interface PropertyDto {
  id: string;
  name: string;
  code: string;
  type: PropertyType;
  status: PropertyStatus;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
  timeZone: string;
  currency: string;
  createdAt: string;
}

/** GET a property: the property plus the caller's permissions on it (for UI only). */
export interface PropertyDetailResponse extends PropertyDto {
  permissions: string[];
}

// ---------------------------------------------------------------------------------------------
// Property structure (Phase 3): buildings, floors, units, common areas
// ---------------------------------------------------------------------------------------------

export type StructureStatus = 'ACTIVE' | 'ARCHIVED';

export interface UpdatePropertyRequest {
  name?: string;
  type?: PropertyType;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  timeZone?: string;
  /** Only while the property is ONBOARDING. */
  countryCode?: string;
  /** Only while the property is ONBOARDING. */
  currency?: string;
}

export interface BuildingDto {
  id: string;
  propertyId: string;
  name: string;
  code: string;
  status: StructureStatus;
  archivedAt: string | null;
  createdAt: string;
}

export interface CreateBuildingRequest {
  name: string;
  /** Unique in the property; letters, digits and hyphens, up to 20 characters. */
  code: string;
}

export interface FloorDto {
  id: string;
  propertyId: string;
  buildingId: string;
  /** 0 = ground, negative = basement. Unique per building. */
  level: number;
  name: string;
  status: StructureStatus;
  archivedAt: string | null;
  createdAt: string;
}

export interface CreateFloorRequest {
  level: number;
  name: string;
}

export type UnitType =
  | 'APARTMENT'
  | 'PENTHOUSE'
  | 'STUDIO'
  | 'DUPLEX'
  | 'VILLA'
  | 'TOWNHOUSE'
  | 'SHOP'
  | 'OFFICE'
  | 'STORAGE'
  | 'OTHER';

export interface UnitDto {
  id: string;
  propertyId: string;
  /** Null for units directly in the property (e.g. villas). */
  buildingId: string | null;
  floorId: string | null;
  number: string;
  type: UnitType;
  /** Square metres as a decimal string with 2 decimals, e.g. "85.50". Never a JSON number. */
  areaSqm: string | null;
  /** Decimal string with 6 decimals, used to apportion shared charges. */
  shareRatio: string | null;
  status: StructureStatus;
  archivedAt: string | null;
  createdAt: string;
}

export interface CreateUnitRequest {
  number: string;
  type: UnitType;
  buildingId?: string;
  /** Requires buildingId; must be a floor of that building. */
  floorId?: string;
  areaSqm?: string;
  shareRatio?: string;
}

export type CommonAreaType =
  | 'LOBBY'
  | 'POOL'
  | 'GYM'
  | 'CLUBHOUSE'
  | 'FUNCTION_ROOM'
  | 'SPORTS_FACILITY'
  | 'PLAYGROUND'
  | 'GARDEN'
  | 'PARKING'
  | 'OTHER';

export interface CommonAreaDto {
  id: string;
  propertyId: string;
  buildingId: string | null;
  name: string;
  type: CommonAreaType;
  status: StructureStatus;
  archivedAt: string | null;
  createdAt: string;
}

export interface CreateCommonAreaRequest {
  name: string;
  type: CommonAreaType;
  buildingId?: string;
}

// ---------------------------------------------------------------------------------------------
// Residents (Phase 4)
// ---------------------------------------------------------------------------------------------

/** Roles a person holds on a unit because of their records (never assigned directly). */
export type ResidentRole = 'OWNER' | 'TENANT' | 'HOUSEHOLD_MEMBER';

/** An item of GET /organisations/:id/my-units. */
export interface MyUnitDto {
  unitId: string;
  unitNumber: string;
  unitType: string;
  propertyId: string;
  propertyName: string;
  buildingName: string | null;
  roles: ResidentRole[] | string[];
}

/** GET …/properties/:propertyId/units/:unitId */
export interface UnitDetailResponse {
  unitId: string;
  unitNumber: string;
  unitType: string;
  status: string;
  /** Decimal string, e.g. "85.50". */
  areaSqm: string | null;
  propertyId: string;
  propertyName: string;
  /** IANA time zone of the property, e.g. "Asia/Karachi". */
  propertyTimeZone: string;
  buildingName: string | null;
  floorName: string | null;
  /** The caller's own resident roles on this unit today; empty for staff. */
  myRoles: string[];
  permissions: string[];
}

/** GET …/units/:unitId/residents: current residents, names and roles only. Dates are YYYY-MM-DD. */
export interface UnitResidentsResponse {
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

// ---------------------------------------------------------------------------------------------
// Residents, staff side (Phase 4 Part 3). Dates are YYYY-MM-DD in the property's calendar, with
// inclusive end dates; null means open-ended.
// ---------------------------------------------------------------------------------------------

export interface PersonDto {
  id: string;
  fullName: string;
  email: string | null;
  /** E.164, e.g. "+923001234567". */
  phone: string | null;
  /** BCP 47, e.g. "ur-PK". */
  preferredLanguage: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  /** True once the profile is linked to a login (resident invitation accepted). */
  linked: boolean;
  createdAt: string;
}

export interface CreatePersonRequest {
  fullName: string;
  email?: string;
  phone?: string;
  preferredLanguage?: string;
}

export interface EmergencyContactDto {
  id: string;
  name: string;
  phone: string;
  relationship: string | null;
}

export interface OwnershipDto {
  id: string;
  unitId: string;
  personId: string;
  fullName: string;
  shareNumerator: number;
  shareDenominator: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

/** POST …/units/:unitId/owners: owners from `effectiveFrom`; shares must sum to exactly one. */
export interface SetOwnersRequest {
  effectiveFrom: string;
  owners: { personId: string; shareNumerator: number; shareDenominator: number }[];
}

export interface TenancyDto {
  id: string;
  unitId: string;
  startDate: string;
  endDate: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  occupants: { personId: string; fullName: string; isPrimary: boolean }[];
}

export interface CreateTenancyRequest {
  startDate: string;
  endDate?: string;
  /** Exactly one occupant must be primary. */
  occupants: { personId: string; isPrimary?: boolean }[];
}

export type HouseholdRelationship =
  | 'SPOUSE_OR_PARTNER'
  | 'CHILD'
  | 'PARENT'
  | 'OTHER_RELATIVE'
  | 'DOMESTIC_STAFF'
  | 'OTHER';

export interface HouseholdMemberDto {
  id: string;
  unitId: string;
  personId: string;
  fullName: string;
  relationship: string;
  validFrom: string;
  validTo: string | null;
  voidedAt: string | null;
}

export interface AddHouseholdMemberRequest {
  personId: string;
  relationship: HouseholdRelationship;
  validFrom: string;
  validTo?: string;
}

export interface VehicleDto {
  id: string;
  /** Upper case, no spaces. */
  plate: string;
  make: string | null;
  model: string | null;
  colour: string | null;
  unitId: string | null;
  personId: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
}

/** An item of GET …/properties/:propertyId/residents. */
export interface PropertyResidentDto {
  person: PersonDto;
  units: { unitId: string; unitNumber: string; roles: string[] }[];
}

/** GET …/properties/:propertyId/persons/:personId: the person and their records in this property. */
export interface PersonDetailResponse {
  person: PersonDto;
  ownerships: OwnershipDto[];
  tenancies: TenancyDto[];
  household: HouseholdMemberDto[];
  emergencyContacts: EmergencyContactDto[];
}

// ---------------------------------------------------------------------------------------------
// Visitors and access (Phase 5). Times are ISO 8601 instants (UTC); the console shows them in
// the property's time zone. A pass is never proof of identity: the guard still checks the person.
// ---------------------------------------------------------------------------------------------

export type VisitorCategory = 'GUEST' | 'DELIVERY' | 'CONTRACTOR' | 'SERVICE_PROVIDER';

/** POST …/units/:unitId/visitor-invitations */
export interface CreateVisitorInvitationRequest {
  category: VisitorCategory;
  visitorName: string;
  /** E.164; spaces and dashes are removed. */
  visitorPhone?: string;
  /** Normalised to upper case without spaces. */
  vehiclePlate?: string;
  /** ISO 8601 instant with an offset, e.g. "2026-11-12T18:00:00+05:00". */
  validFrom: string;
  /** After validFrom, at most 31 days later. */
  validUntil: string;
  /** 1-50; default 1. */
  maxEntries?: number;
}

export interface VisitorInvitationDto {
  id: string;
  unitId: string;
  unitNumber: string;
  category: VisitorCategory;
  visitorName: string;
  visitorPhone: string | null;
  vehiclePlate: string | null;
  validFrom: string;
  validUntil: string;
  maxEntries: number;
  entriesUsed: number;
  status: 'ACTIVE' | 'REVOKED';
  revokedAt: string | null;
  /** True when the caller created it (residents may revoke any invitation of their unit). */
  createdByMe: boolean;
  createdAt: string;
}

/**
 * The pass, returned once when an invitation is created and never again (only hashes are
 * stored). The QR code encodes `token`; `code` is typed by a guard when scanning is not possible.
 */
export interface VisitorPassSecretDto {
  token: string;
  /** Eight characters shown as XXXX-XXXX. */
  code: string;
}

export interface CreateVisitorInvitationResponse {
  invitation: VisitorInvitationDto;
  pass: VisitorPassSecretDto;
}

/** POST …/properties/:propertyId/gate/validate: exactly one of token or code. */
export interface ValidatePassRequest {
  token?: string;
  code?: string;
  gate?: string;
}

export type PassRejectionReason =
  | 'NOT_FOUND'
  | 'REVOKED'
  | 'NOT_YET_VALID'
  | 'EXPIRED'
  | 'NO_ENTRIES_LEFT'
  | 'HOST_NO_LONGER_RESIDENT';

/** What a guard sees: the minimum needed to check the person in front of them. */
export interface GatePassView {
  invitationId: string;
  passId: string;
  category: VisitorCategory;
  visitorName: string;
  vehiclePlate: string | null;
  unitNumber: string;
  validUntil: string;
  entriesLeft: number;
}

export type ValidatePassResponse =
  | { valid: true; pass: GatePassView }
  | { valid: false; reason: PassRejectionReason };

/** POST …/gate/admit */
export interface AdmitVisitorRequest {
  passId: string;
  gate?: string;
}

/** POST …/gate/deny: for a pass (details come from it) or for someone without one. */
export interface DenyVisitorRequest {
  passId?: string;
  unitId?: string;
  category?: VisitorCategory;
  visitorName?: string;
  vehiclePlate?: string;
  reason: string;
  gate?: string;
}

/**
 * POST …/gate/walk-in: someone without a pass. Walk-ins to a unit need the resident's in-app
 * approval (Phase 5 Part 3) and are refused with WALK_IN_NEEDS_APPROVAL until then; walk-ins to
 * the property itself (no unitId) are admitted and recorded.
 */
export interface WalkInRequest {
  unitId?: string;
  category: VisitorCategory;
  visitorName: string;
  visitorPhone?: string;
  vehiclePlate?: string;
  gate?: string;
}

export interface VisitDto {
  id: string;
  unitId: string | null;
  unitNumber: string | null;
  invitationId: string | null;
  category: VisitorCategory;
  visitorName: string;
  vehiclePlate: string | null;
  decision: 'ADMITTED' | 'DENIED';
  denialReason: string | null;
  gate: string | null;
  arrivedAt: string;
  departedAt: string | null;
  source: 'ONLINE' | 'PAPER' | 'OFFLINE_SYNC';
  /** Paper and offline entries the pass would not have allowed, e.g. REVOKED; null otherwise. */
  reviewReason: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

// ---------------------------------------------------------------------------------------------
// Walk-in approval (Phase 5 Part 3): a guard asks the unit's residents to let in someone without
// a pass. Residents answer in the app within 10 minutes; an approval admits once within 15.
// ---------------------------------------------------------------------------------------------

/** POST …/properties/:propertyId/gate/walk-in-requests */
export interface CreateWalkInRequest {
  unitId: string;
  category: VisitorCategory;
  visitorName: string;
  visitorPhone?: string;
  vehiclePlate?: string;
  gate?: string;
}

/** EXPIRED: no answer in time. APPROVED stays APPROVED; see approvalValidUntil and used. */
export type WalkInRequestStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'CANCELLED' | 'EXPIRED';

export interface WalkInRequestDto {
  id: string;
  unitId: string;
  unitNumber: string;
  category: VisitorCategory;
  visitorName: string;
  visitorPhone: string | null;
  vehiclePlate: string | null;
  gate: string | null;
  status: WalkInRequestStatus;
  createdAt: string;
  /** The residents' deadline to answer. */
  expiresAt: string;
  decidedAt: string | null;
  /** For an approval: the guard must admit before this time. */
  approvalValidUntil: string | null;
  /** True once a visit was admitted on this approval. */
  used: boolean;
}

// ---------------------------------------------------------------------------------------------
// Offline gate and paper log (Phase 5 Part 5). The offline list holds pass hashes, never codes:
// the gate device hashes what it scans or is told, exactly as the API does:
//   tokenHash = sha256hex("token:" + token)
//   codeHash  = sha256hex("code:" + propertyId + ":" + CODE)   (CODE: upper case, no spaces/hyphens)
// ---------------------------------------------------------------------------------------------

export interface OfflineListEntry {
  invitationId: string;
  passId: string;
  tokenHash: string;
  codeHash: string;
  category: VisitorCategory;
  visitorName: string;
  vehiclePlate: string | null;
  unitNumber: string;
  validFrom: string;
  validUntil: string;
  entriesLeft: number;
}

/** GET …/gate/offline-list: passes usable in the next 4 hours. Not to be used after trustUntil. */
export interface OfflineListResponse {
  propertyId: string;
  generatedAt: string;
  trustUntil: string;
  entries: OfflineListEntry[];
}

export type LateEntryKind = 'ADMIT' | 'DENY' | 'WALK_IN' | 'DEPART';

/** One thing that happened at the gate while VEYRA could not be reached. */
export interface LateEntry {
  /** Chosen by the device (UUID); a retried sync with the same reference records nothing new. */
  clientRef: string;
  kind: LateEntryKind;
  /** When it happened: at most 7 days ago, never in the future. */
  occurredAt: string;
  gate?: string;
  /** ADMIT / DENY on a pass: from the offline list. */
  passId?: string;
  /** Paper log: the reference code written down, instead of passId. */
  code?: string;
  /** DENY: why. */
  reason?: string;
  /** WALK_IN / DENY without a pass. */
  category?: VisitorCategory;
  visitorName?: string;
  vehiclePlate?: string;
  /** WALK_IN to a unit (recorded and flagged: the resident could not approve). */
  unitId?: string;
  /** DEPART: a visit recorded online, or the clientRef of an entry in the same or an earlier sync. */
  visitId?: string;
  departRef?: string;
}

/** POST …/gate/late-entries. OFFLINE_SYNC: the gate device. PAPER: a supervisor typing the log. */
export interface SyncLateEntriesRequest {
  source: 'OFFLINE_SYNC' | 'PAPER';
  entries: LateEntry[];
}

export interface LateEntryResult {
  clientRef: string;
  status: 'RECORDED' | 'ALREADY_RECORDED' | 'REJECTED';
  visitId?: string;
  /** Set when the entry was recorded but needs a supervisor's review. */
  reviewReason?: string | null;
  /** For REJECTED: a stable code, e.g. TOO_OLD, IN_THE_FUTURE, NOT_FOUND. */
  error?: string;
}

export interface SyncLateEntriesResponse {
  results: LateEntryResult[];
}

// ------------------------------------------------------------------------------------------
// Finance (Phase 6). Amounts are MoneyDto (minor units as strings) in the property's currency;
// amounts sent by clients are decimal strings such as "1500.50" in that currency. Months are
// "YYYY-MM"; dates are property-local "YYYY-MM-DD".
// ------------------------------------------------------------------------------------------

export type LedgerAccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

export interface LedgerAccountDto {
  id: string;
  code: string;
  name: string;
  type: LedgerAccountType;
  /** Set on accounts the system posts to, e.g. RECEIVABLES. */
  systemKey: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
}

/** OWNERS: the unit's owners. OCCUPANT: the current tenants, or the owners while vacant. */
export type ChargeLiableParty = 'OWNERS' | 'OCCUPANT';

export interface ChargeTypeDto {
  id: string;
  code: string;
  name: string;
  liableParty: ChargeLiableParty;
  incomeAccountId: string;
  status: 'ACTIVE' | 'ARCHIVED';
}

export interface FinanceSetupResponse {
  accounts: LedgerAccountDto[];
  chargeTypes: ChargeTypeDto[];
}

export interface CreateChargeTypeRequest {
  code: string;
  name: string;
  liableParty: ChargeLiableParty;
  incomeAccountId: string;
}

export type RecurringChargeBasis = 'FLAT' | 'PER_SQM';

export interface RecurringChargeDto {
  id: string;
  /** Null: every active unit of the property (a unit's own charge of the same type replaces it). */
  unitId: string | null;
  unitNumber: string | null;
  chargeTypeId: string;
  chargeTypeCode: string;
  basis: RecurringChargeBasis;
  /** FLAT: the monthly amount. PER_SQM: the rate per square metre. */
  amount: MoneyDto;
  startMonth: string;
  endMonth: string | null;
}

export interface CreateRecurringChargeRequest {
  unitId?: string;
  chargeTypeId: string;
  basis: RecurringChargeBasis;
  amount: string;
  startMonth: string;
  endMonth?: string;
}

export interface EndRecurringChargeRequest {
  /** Last month billed. */
  endMonth: string;
}

export type InvoiceStatus = 'DRAFT' | 'ISSUED';

export interface InvoiceRecipientDto {
  personId: string;
  fullName: string;
  /** Ownership share for owners; null for tenants. */
  share: { numerator: number; denominator: number } | null;
}

export interface InvoiceDto {
  id: string;
  /** e.g. "INV-000042"; null while a draft. */
  number: string | null;
  status: InvoiceStatus;
  unitId: string;
  unitNumber: string;
  billTo: 'OWNERS' | 'TENANTS';
  recipients: InvoiceRecipientDto[];
  billingMonth: string | null;
  billingDate: string;
  dueDate: string;
  issueDate: string | null;
  total: MoneyDto;
  /** Paid so far (allocations not released). */
  paid: MoneyDto;
  /** Credit notes and write-offs. */
  credited: MoneyDto;
  outstanding: MoneyDto;
  /** Issued, not settled and past its due date. */
  overdue: boolean;
  createdAt: string;
  issuedAt: string | null;
}

export interface InvoiceLineDto {
  lineNumber: number;
  chargeTypeId: string;
  chargeTypeCode: string;
  description: string;
  amount: MoneyDto;
  billingMonth: string | null;
}

export interface InvoiceCreditDto {
  id: string;
  kind: 'CREDIT_NOTE' | 'WRITE_OFF';
  /** "CRN-000042" for credit notes; null for write-offs. */
  number: string | null;
  lineNumber: number | null;
  amount: MoneyDto;
  reason: string;
  creditedOn: string;
}

export interface InvoiceDetailDto extends InvoiceDto {
  lines: InvoiceLineDto[];
  credits: InvoiceCreditDto[];
  journalEntryId: string | null;
}

export interface BillingRunRequest {
  month: string;
  dueDate: string;
  /** Issue the new invoices at once (default: leave them as drafts to review). */
  issue?: boolean;
}

export interface BillingRunSkip {
  unitId: string;
  unitNumber: string;
  chargeTypeCode: string;
  /** NO_AREA: a per-sqm charge on a unit without an area. NO_OWNER: nobody to bill. */
  reason: 'NO_AREA' | 'NO_OWNER';
}

export interface BillingRunResponse {
  month: string;
  invoices: InvoiceDto[];
  skipped: BillingRunSkip[];
}

export interface CreateInvoiceRequest {
  unitId: string;
  dueDate: string;
  lines: { chargeTypeId: string; description?: string; amount: string }[];
}

export interface IssueInvoiceRequest {
  /** Replaces the due date (it may not be before the issue date). */
  dueDate?: string;
}

// Payments (Phase 6 Part 3).

export type PaymentMethod = 'BANK_TRANSFER' | 'CASH' | 'CHEQUE' | 'GATEWAY';

export interface PaymentAllocationDto {
  id: string;
  invoiceId: string;
  invoiceNumber: string | null;
  amount: MoneyDto;
  createdAt: string;
  /** Set when the allocation was taken back (the money returned to the payment's unused part). */
  releasedAt: string | null;
}

/** A payment is also its receipt. */
export interface PaymentDto {
  id: string;
  /** e.g. "RCT-000042". */
  receiptNumber: string;
  unitId: string;
  unitNumber: string;
  paidBy: 'OWNERS' | 'TENANTS';
  method: PaymentMethod;
  amount: MoneyDto;
  /** Applied to invoices (allocations not released). */
  allocated: MoneyDto;
  /** Kept as the unit's credit for this party's later invoices. */
  unallocated: MoneyDto;
  refunded: MoneyDto;
  /** Set when the payment was reversed (e.g. a bounced cheque). */
  reversedOn: string | null;
  receivedOn: string;
  reference: string | null;
  allocations: PaymentAllocationDto[];
  createdAt: string;
}

/** Send with an Idempotency-Key header (a UUID); a retry with the same key returns the same payment. */
export interface RecordPaymentRequest {
  unitId: string;
  paidBy: 'OWNERS' | 'TENANTS';
  method: 'BANK_TRANSFER' | 'CASH' | 'CHEQUE';
  amount: string;
  receivedOn: string;
  reference?: string;
}

export interface AllocatePaymentRequest {
  invoiceId: string;
  amount: string;
}

export interface CreatePaymentIntentRequest {
  unitId: string;
  paidBy: 'OWNERS' | 'TENANTS';
  amount: string;
}

export interface PaymentIntentDto {
  id: string;
  unitId: string;
  paidBy: 'OWNERS' | 'TENANTS';
  amount: MoneyDto;
  provider: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';
  expiresAt: string;
  completedAt: string | null;
  paymentId: string | null;
}

export interface CreatePaymentIntentResponse {
  intent: PaymentIntentDto;
  /** Where the payer completes the payment with the provider. */
  checkoutUrl: string;
}

// Controls and reports (Phase 6 Part 4).

export type FinanceApprovalAction = 'REVERSE_PAYMENT' | 'REFUND' | 'WRITE_OFF' | 'REOPEN_PERIOD';
export type FinanceApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

/** A risky action waiting for, or decided by, a second person. */
export interface FinanceApprovalDto {
  id: string;
  action: FinanceApprovalAction;
  status: FinanceApprovalStatus;
  paymentId: string | null;
  invoiceId: string | null;
  periodId: string | null;
  amount: MoneyDto | null;
  refundMethod: 'BANK_TRANSFER' | 'CASH' | 'CHEQUE' | null;
  reason: string;
  requestedBy: { userId: string; name: string };
  decidedBy: { userId: string; name: string } | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

export type FinanceApprovalRequest =
  | { action: 'REVERSE_PAYMENT'; paymentId: string; reason: string }
  | {
      action: 'REFUND';
      paymentId: string;
      amount: string;
      method: 'BANK_TRANSFER' | 'CASH' | 'CHEQUE';
      reason: string;
    }
  | { action: 'WRITE_OFF'; invoiceId: string; amount: string; reason: string }
  | { action: 'REOPEN_PERIOD'; periodId: string; reason: string };

export interface ApprovalDecisionRequest {
  note?: string;
}

export interface AccountingPeriodDto {
  id: string;
  startDate: string;
  endDate: string;
  status: 'OPEN' | 'CLOSED';
  closedAt: string | null;
}

export interface CreateCreditNoteRequest {
  lineNumber: number;
  amount: string;
  reason: string;
}

export type StatementLineKind =
  | 'INVOICE'
  | 'CREDIT_NOTE'
  | 'WRITE_OFF'
  | 'PAYMENT'
  | 'REFUND'
  | 'PAYMENT_REVERSAL';

export interface StatementLineDto {
  date: string;
  kind: StatementLineKind;
  reference: string;
  /** Adds to what is owed. */
  debit: MoneyDto;
  /** Reduces it. */
  credit: MoneyDto;
  /** Positive: owed; negative: credit held. */
  balance: MoneyDto;
}

export interface StatementDto {
  unitId: string;
  unitNumber: string;
  paidBy: 'OWNERS' | 'TENANTS';
  tenancyId: string | null;
  asOf: string;
  lines: StatementLineDto[];
  balance: MoneyDto;
}

export interface AgeingBucketsDto {
  /** Not yet due. */
  current: MoneyDto;
  days1to30: MoneyDto;
  days31to60: MoneyDto;
  days61to90: MoneyDto;
  over90: MoneyDto;
}

export interface AgeingRowDto {
  unitId: string;
  unitNumber: string;
  billTo: 'OWNERS' | 'TENANTS';
  tenancyId: string | null;
  buckets: AgeingBucketsDto;
  total: MoneyDto;
}

export interface AgeingDto {
  asOf: string;
  rows: AgeingRowDto[];
  totals: AgeingBucketsDto;
}

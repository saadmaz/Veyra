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

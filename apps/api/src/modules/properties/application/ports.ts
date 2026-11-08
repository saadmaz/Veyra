import type { RequestMeta } from '../../../platform/request-meta';
import type { PropertyStatus } from '../../access-control';
import type { CreatePropertyInput, PropertyType } from '../domain/property-rules';

export interface PropertyRecord {
  id: string;
  organisationId: string;
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
  createdAt: Date;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/** Which properties a listing may include, decided by access-control. */
export type PropertyFilter = { all: true } | { all: false; propertyIds: string[] };

/** Signals a property code already used in the organisation (including a concurrent create). */
export class PropertyCodeTakenError extends Error {}

/** All operations run inside the organisation's RLS context and filter by organisation_id. */
export interface PropertiesRepository {
  /** Creates the property (defaults from the organisation) and its audit record, atomically. */
  create(
    organisationId: string,
    actorUserId: string,
    input: CreatePropertyInput,
    meta: RequestMeta,
  ): Promise<PropertyRecord>;

  list(
    organisationId: string,
    actorUserId: string,
    filter: PropertyFilter,
    page: { limit: number; cursor?: string | undefined },
  ): Promise<Page<PropertyRecord>>;

  get(
    organisationId: string,
    actorUserId: string,
    propertyId: string,
  ): Promise<PropertyRecord | null>;
}
export const PROPERTIES_REPOSITORY = Symbol('PROPERTIES_REPOSITORY');

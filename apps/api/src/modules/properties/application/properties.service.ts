import { Inject, Injectable } from '@nestjs/common';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import type { ListQuery } from '../../../platform/validation/common-schemas';
import { AccessControlService, type OrganisationAccess } from '../../access-control';
import type { CreatePropertyInput } from '../domain/property-rules';
import {
  type Page,
  PROPERTIES_REPOSITORY,
  type PropertiesRepository,
  PropertyCodeTakenError,
  type PropertyRecord,
} from './ports';

@Injectable()
export class PropertiesService {
  constructor(
    @Inject(PROPERTIES_REPOSITORY) private readonly repository: PropertiesRepository,
    private readonly accessControl: AccessControlService,
  ) {}

  async create(
    access: OrganisationAccess,
    input: CreatePropertyInput,
    meta: RequestMeta,
  ): Promise<PropertyRecord> {
    try {
      return await this.repository.create(access.organisationId, access.userId, input, meta);
    } catch (error) {
      if (error instanceof PropertyCodeTakenError) {
        throw new ApiError(409, 'PROPERTY_CODE_TAKEN', 'Another property already uses this code');
      }
      throw error;
    }
  }

  /**
   * Properties the caller may see: every property for organisation-wide roles, otherwise only
   * the properties their property-scoped grants cover. Never trusts a client-supplied filter.
   */
  async list(access: OrganisationAccess, query: ListQuery): Promise<Page<PropertyRecord>> {
    const filter = await this.accessControl.propertiesReachable(
      access.userId,
      access.organisationId,
      'property.profile.read',
    );
    if (!filter.all && filter.propertyIds.length === 0) return { data: [], nextCursor: null };
    return this.repository.list(access.organisationId, access.userId, filter, query);
  }

  async get(access: OrganisationAccess): Promise<PropertyRecord> {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    const property = await this.repository.get(
      access.organisationId,
      access.userId,
      access.propertyId,
    );
    if (!property) throw new ApiError(404, 'NOT_FOUND', 'Not found');
    return property;
  }
}

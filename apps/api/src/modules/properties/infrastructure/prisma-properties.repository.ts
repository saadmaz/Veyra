import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, isUniqueViolation, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import {
  type Page,
  type PropertiesRepository,
  PropertyCodeTakenError,
  type PropertyFilter,
  type PropertyRecord,
} from '../application/ports';
import type { CreatePropertyInput } from '../domain/property-rules';

const PROPERTY_SELECT = {
  id: true,
  organisationId: true,
  name: true,
  code: true,
  type: true,
  status: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  region: true,
  postalCode: true,
  countryCode: true,
  timeZone: true,
  currency: true,
  createdAt: true,
} as const;

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

/**
 * Properties inside the organisation's RLS context (withTenantTransaction). Queries also filter
 * by organisation_id explicitly; RLS is the second line of defence.
 */
@Injectable()
export class PrismaPropertiesRepository implements PropertiesRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  create(
    organisationId: string,
    actorUserId: string,
    input: CreatePropertyInput,
    meta: RequestMeta,
  ): Promise<PropertyRecord> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      async (tx) => {
        const organisation = await tx.organisation.findUniqueOrThrow({
          where: { id: organisationId },
          select: { countryCode: true, defaultTimeZone: true, defaultCurrency: true },
        });
        let property: PropertyRecord;
        try {
          property = await tx.property.create({
            data: {
              organisationId,
              name: input.name,
              code: input.code,
              type: input.type,
              addressLine1: input.addressLine1,
              addressLine2: input.addressLine2 ?? null,
              city: input.city,
              region: input.region ?? null,
              postalCode: input.postalCode ?? null,
              countryCode: input.countryCode ?? organisation.countryCode,
              timeZone: input.timeZone ?? organisation.defaultTimeZone,
              currency: input.currency ?? organisation.defaultCurrency,
            },
            select: PROPERTY_SELECT,
          });
        } catch (error) {
          if (isUniqueViolation(error, 'code')) throw new PropertyCodeTakenError();
          throw error;
        }
        await tx.auditLog.createMany({
          data: [
            {
              organisationId,
              actorUserId,
              action: 'property.created',
              resourceType: 'property',
              resourceId: property.id,
              metadata: { code: property.code },
              requestId: clip(meta.requestId, 128),
              ipAddress: clip(meta.ipAddress, 64),
            },
          ],
        });
        return property;
      },
      { userId: actorUserId },
    );
  }

  async list(
    organisationId: string,
    actorUserId: string,
    filter: PropertyFilter,
    page: { limit: number; cursor?: string | undefined },
  ): Promise<Page<PropertyRecord>> {
    // One id condition: the caller's reachable properties and the keyset cursor combined.
    const id = {
      ...(filter.all ? {} : { in: filter.propertyIds }),
      ...(page.cursor ? { gt: page.cursor } : {}),
    };
    const rows = await withTenantTransaction(
      this.db,
      { organisationId },
      (tx) =>
        tx.property.findMany({
          where: { organisationId, ...(Object.keys(id).length > 0 ? { id } : {}) },
          orderBy: { id: 'asc' },
          take: page.limit + 1,
          select: PROPERTY_SELECT,
        }),
      { userId: actorUserId },
    );
    const data = rows.slice(0, page.limit);
    return { data, nextCursor: rows.length > page.limit ? (data.at(-1)?.id ?? null) : null };
  }

  get(
    organisationId: string,
    actorUserId: string,
    propertyId: string,
  ): Promise<PropertyRecord | null> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) =>
        tx.property.findFirst({
          where: { id: propertyId, organisationId },
          select: PROPERTY_SELECT,
        }),
      { userId: actorUserId },
    );
  }
}

import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { ROUTE_ACCESS, type RouteAccess } from '../../../platform/auth/route-access';
import type { OrganisationAccess } from '../application/access-control.service';
import type { Permission } from '../domain/permissions';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by PermissionGuard on @RequirePermission routes. */
    access?: OrganisationAccess;
  }
}

/** The route's organisation comes from the `:organisationId` path parameter. */
export const ORGANISATION_ID_PARAM = 'organisationId';

/** Property-scoped permissions (property.*) take the property from the `:propertyId` parameter. */
export const PROPERTY_ID_PARAM = 'propertyId';

/** Unit-scoped permissions (unit.*) take the unit from the `:unitId` parameter. */
export const UNIT_ID_PARAM = 'unitId';

/**
 * Requires a signed-in member of the route's :organisationId holding `permission`. The route
 * path must contain :organisationId, and :propertyId for property.* permissions (checked at
 * startup).
 */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(ROUTE_ACCESS, { kind: 'permission', permission } satisfies RouteAccess);

/** The caller's resolved access on a @RequirePermission route. */
export const CurrentAccess = createParamDecorator(
  (_data: unknown, context: ExecutionContext): OrganisationAccess => {
    const access = context.switchToHttp().getRequest<Request>().access;
    if (!access) {
      throw new Error('CurrentAccess used on a route without @RequirePermission');
    }
    return access;
  },
);

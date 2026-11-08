import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROUTE_ACCESS, type RouteAccess } from '../../../platform/auth/route-access';
import { ApiError } from '../../../platform/errors/api-error';
import { AccessControlService } from '../application/access-control.service';
import { isPermission } from '../domain/permissions';
import { ORGANISATION_ID_PARAM } from './require-permission.decorator';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Global guard that runs after AuthGuard (order fixed in AppModule). Enforces the route's
 * declared access level; a route without a declaration is denied (startup also refuses it).
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessControl: AccessControlService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    const access = this.reflector.getAllAndOverride<RouteAccess | undefined>(ROUTE_ACCESS, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request>();

    switch (access?.kind) {
      case 'public':
        return true;
      case 'authenticated':
        return this.requirePrincipal(req);
      case 'permission': {
        const userId = this.requirePrincipal(req) && req.principal?.userId;
        const organisationId = req.params[ORGANISATION_ID_PARAM];
        if (!userId || !isPermission(access.permission)) return false;
        // Malformed ids are treated like unknown organisations (no oracle on id formats).
        if (typeof organisationId !== 'string' || !UUID.test(organisationId)) {
          throw new ApiError(404, 'NOT_FOUND', 'Organisation not found');
        }
        req.access = await this.accessControl.authorise(
          userId,
          organisationId.toLowerCase(),
          access.permission,
        );
        return true;
      }
      default:
        return false;
    }
  }

  private requirePrincipal(req: Request): boolean {
    if (!req.principal) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
    return true;
  }
}

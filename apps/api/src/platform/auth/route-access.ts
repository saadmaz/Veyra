import { SetMetadata } from '@nestjs/common';

/**
 * Every route declares exactly one access level. Undeclared routes fail application startup
 * (see access-control RouteAccessVerifier), so "forgot to protect it" cannot ship.
 *
 *   @Public()                      no session needed (health, sign-up, sign-in)
 *   @Authenticated()               any signed-in user, no organisation context (my profile,
 *                                  my organisations, accept an invitation)
 *   @RequirePermission('x.y.z')    signed-in member of the route's :organisationId holding
 *                                  the permission (access-control module)
 */
export type RouteAccess =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permission: string };

export const ROUTE_ACCESS = 'veyra:routeAccess';

export const Public = () => SetMetadata(ROUTE_ACCESS, { kind: 'public' } satisfies RouteAccess);

export const Authenticated = () =>
  SetMetadata(ROUTE_ACCESS, { kind: 'authenticated' } satisfies RouteAccess);

import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedPrincipal } from '../application/identity-provider';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by AuthGuard on authenticated routes. */
    principal?: AuthenticatedPrincipal;
  }
}

/** The authenticated caller. Only valid on routes that are not @Public(). */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal => {
    const principal = context.switchToHttp().getRequest<Request>().principal;
    if (!principal) {
      // Programming error: the route is public or the guard did not run.
      throw new Error('CurrentPrincipal used on a route without an authenticated principal');
    }
    return principal;
  },
);

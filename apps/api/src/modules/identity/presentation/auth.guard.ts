import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROUTE_ACCESS, type RouteAccess } from '../../../platform/auth/route-access';
import { API_ENV, type ApiEnv } from '../../../platform/config/env';
import { ApiError } from '../../../platform/errors/api-error';
import { IDENTITY_PROVIDER, type IdentityProvider } from '../application/identity-provider';
import { type CookieSettings, cookieSettings, readCredential } from './session-transport';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Global guard: every route requires a valid session unless marked @Public().
 *
 * It also rejects state-changing requests whose Origin header names a site outside
 * API_CORS_ORIGINS. Browsers always send Origin on cross-site POSTs, so this blocks cross-site
 * request forgery (including forged sign-ins) on top of SameSite=Lax cookies. Native clients
 * send no Origin and are unaffected.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly cookie: CookieSettings;
  private readonly allowedOrigins: ReadonlySet<string>;

  constructor(
    private readonly reflector: Reflector,
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
    @Inject(API_ENV) env: ApiEnv,
  ) {
    this.cookie = cookieSettings(env.NODE_ENV === 'production');
    this.allowedOrigins = new Set(env.API_CORS_ORIGINS);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return false;
    const req = context.switchToHttp().getRequest<Request>();

    const origin = req.header('origin');
    if (!SAFE_METHODS.has(req.method) && origin && !this.allowedOrigins.has(origin)) {
      throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed');
    }

    const access = this.reflector.getAllAndOverride<RouteAccess | undefined>(ROUTE_ACCESS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (access?.kind === 'public') return true;

    const credential = readCredential(req, this.cookie);
    const principal = credential ? await this.identity.authenticate(credential) : null;
    if (!principal) {
      throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
    }
    req.principal = principal;
    return true;
  }
}

import { Body, Controller, Get, Header, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthResponse, CurrentSessionResponse } from '@veyra/api-contracts';
import type { Request, Response } from 'express';
import { Public } from '../../../platform/auth/public.decorator';
import { API_ENV, type ApiEnv } from '../../../platform/config/env';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import {
  type AuthenticatedPrincipal,
  IDENTITY_PROVIDER,
  type IdentityProvider,
} from '../application/identity-provider';
import { type IssuedSession, PasswordAuthService } from '../application/password-auth.service';
import type { RequestMeta } from '../application/ports';
import {
  type SignInInput,
  type SignUpInput,
  signInSchema,
  signUpSchema,
} from '../domain/credentials';
import { CurrentPrincipal } from './current-principal.decorator';
import {
  type CookieSettings,
  clearSessionCookie,
  cookieSettings,
  setSessionCookie,
} from './session-transport';

function requestMeta(req: Request): RequestMeta {
  return {
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    requestId: req.requestId ?? null,
  };
}

const toClient = (client: 'WEB' | 'MOBILE') => (client === 'MOBILE' ? 'mobile' : 'web');

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly cookie: CookieSettings;

  constructor(
    private readonly passwordAuth: PasswordAuthService,
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
    @Inject(API_ENV) env: ApiEnv,
  ) {
    this.cookie = cookieSettings(env.NODE_ENV === 'production');
  }

  @Public()
  @Post('sign-up')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Create an account and start a session.' })
  async signUp(
    @Body(new ZodValidationPipe(signUpSchema)) body: SignUpInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(await this.passwordAuth.signUp(body, requestMeta(req)), res);
  }

  @Public()
  @Post('sign-in')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Start a session with email and password.' })
  async signIn(
    @Body(new ZodValidationPipe(signInSchema)) body: SignInInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(await this.passwordAuth.signIn(body, requestMeta(req)), res);
  }

  @Post('sign-out')
  @HttpCode(204)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'End the current session.' })
  async signOut(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.identity.signOut(principal, requestMeta(req));
    if (principal.client === 'WEB') clearSessionCookie(res, this.cookie);
  }

  @Get('session')
  @Header('Cache-Control', 'no-store')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'The signed-in user and current session.' })
  session(@CurrentPrincipal() principal: AuthenticatedPrincipal): CurrentSessionResponse {
    return {
      user: { id: principal.userId, email: principal.email, displayName: principal.displayName },
      session: { client: toClient(principal.client) },
    };
  }

  /** Web: token only in the httpOnly cookie, never in the body. Mobile: token in the body. */
  private respond(issued: IssuedSession, res: Response): AuthResponse {
    const { user, session, token } = issued;
    const body: AuthResponse = {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      session: {
        client: toClient(session.client),
        idleExpiresAt: session.idleExpiresAt.toISOString(),
        absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
      },
    };
    if (session.client === 'WEB') {
      setSessionCookie(res, this.cookie, token, session.absoluteExpiresAt);
    } else {
      body.token = token;
    }
    return body;
  }
}

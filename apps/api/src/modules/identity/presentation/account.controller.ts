import { Body, Controller, Header, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Authenticated, Public } from '../../../platform/auth/route-access';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { AccountService } from '../application/account.service';
import type { AuthenticatedPrincipal } from '../application/identity-provider';
import type { RequestMeta } from '../application/ports';
import { passwordSchema } from '../domain/credentials';
import { CurrentPrincipal } from './current-principal.decorator';

const token = z.string().trim().min(1).max(100);
const verifySchema = z.object({ token });
const resetRequestSchema = z.object({ email: z.email().max(254) });
const resetConfirmSchema = z.object({ token, password: passwordSchema });

const meta = (req: Request): RequestMeta => ({
  ipAddress: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
  requestId: req.requestId ?? null,
});

/** Email verification and password reset (Phase 14 Part 1, ADR 0005). */
@ApiTags('auth')
@Controller('auth')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Public()
  @Post('verify-email')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Confirm the email address with the token from its link.' })
  async verify(
    @Body(new ZodValidationPipe(verifySchema)) body: { token: string },
    @Req() req: Request,
  ): Promise<void> {
    await this.account.verifyEmail(body.token, meta(req));
  }

  @Authenticated()
  @Post('verify-email/resend')
  @HttpCode(202)
  @ApiOperation({ summary: 'Send the confirmation link again (rate limited).' })
  async resend(@CurrentPrincipal() principal: AuthenticatedPrincipal): Promise<void> {
    await this.account.resendVerification(principal.userId);
  }

  @Public()
  @Post('password-reset')
  @HttpCode(202)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Email a reset link if the account exists. Answers the same either way.',
  })
  async requestReset(
    @Body(new ZodValidationPipe(resetRequestSchema)) body: { email: string },
    @Req() req: Request,
  ): Promise<void> {
    await this.account.requestReset(body.email, meta(req));
  }

  @Public()
  @Post('password-reset/confirm')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Set a new password with the token from the link; signs out everywhere.',
  })
  async confirmReset(
    @Body(new ZodValidationPipe(resetConfirmSchema)) body: { token: string; password: string },
    @Req() req: Request,
  ): Promise<void> {
    await this.account.confirmReset(body.token, body.password, meta(req));
  }
}

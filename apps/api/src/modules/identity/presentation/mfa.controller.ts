import { Body, Controller, Get, Header, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { MfaSetupDto, MfaStatusDto } from '@veyra/api-contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { Authenticated } from '../../../platform/auth/route-access';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import type { AuthenticatedPrincipal } from '../application/identity-provider';
import { MfaService } from '../application/mfa.service';
import type { RequestMeta } from '../application/ports';
import { CurrentPrincipal } from './current-principal.decorator';

const code = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from your app');
const codeSchema = z.object({ code });
const verifySchema = z
  .object({ code: code.optional(), recoveryCode: z.string().trim().min(8).max(20).optional() })
  .refine((v) => Boolean(v.code) !== Boolean(v.recoveryCode), 'Enter a code or a recovery code');

const meta = (req: Request): RequestMeta => ({
  ipAddress: req.ip ?? null,
  userAgent: req.header('user-agent') ?? null,
  requestId: req.requestId ?? null,
});

/** Two-step sign-in with an authenticator app (Phase 14 Part 2). */
@ApiTags('auth')
@Controller('auth/mfa')
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @Get()
  @Authenticated()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Whether two-step sign-in is on, and whether this session is verified.',
  })
  status(@CurrentPrincipal() principal: AuthenticatedPrincipal): Promise<MfaStatusDto> {
    return this.mfa.status(principal);
  }

  @Post('setup')
  @Authenticated()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Start: a new secret for the authenticator app (not on until confirmed).',
  })
  setup(@CurrentPrincipal() principal: AuthenticatedPrincipal): Promise<MfaSetupDto> {
    return this.mfa.setup(principal);
  }

  @Post('confirm')
  @HttpCode(200)
  @Authenticated()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Turn it on with a code; returns ten recovery codes, shown only now.' })
  confirm(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(codeSchema)) body: { code: string },
    @Req() req: Request,
  ): Promise<{ recoveryCodes: string[] }> {
    return this.mfa.confirm(principal, body.code, meta(req));
  }

  @Post('verify')
  @HttpCode(204)
  @Authenticated()
  @ApiOperation({ summary: 'Verify this session with a current code or a recovery code.' })
  async verify(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(verifySchema)) body: { code?: string; recoveryCode?: string },
    @Req() req: Request,
  ): Promise<void> {
    await this.mfa.verify(principal, body, meta(req));
  }

  @Post('disable')
  @HttpCode(204)
  @Authenticated()
  @ApiOperation({ summary: 'Turn it off (needs a verified session and a current code).' })
  async disable(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(codeSchema)) body: { code: string },
    @Req() req: Request,
  ): Promise<void> {
    await this.mfa.disable(principal, body.code, meta(req));
  }
}

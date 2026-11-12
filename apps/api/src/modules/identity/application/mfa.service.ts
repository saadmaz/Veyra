import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../platform/clock';
import { ApiError } from '../../../platform/errors/api-error';
import { RATE_LIMITER, type RateLimiter } from '../../../platform/rate-limit/rate-limiter';
import {
  base32Decode,
  matchTotp,
  newRecoveryCodes,
  newTotpSecret,
  normaliseRecoveryCode,
  open,
  otpauthUri,
  seal,
} from '../domain/totp';
import type { AuthenticatedPrincipal } from './identity-provider';
import type { RequestMeta } from './ports';

export interface MfaFactorRecord {
  secretCiphertext: string;
  confirmed: boolean;
  lastUsedStep: number | null;
}

/** Persistence for factors and recovery codes. Each change writes its audit record. */
export interface MfaStore {
  factor(userId: string): Promise<MfaFactorRecord | null>;
  recoveryCodesLeft(userId: string): Promise<number>;
  /** Replaces an unconfirmed factor (a confirmed one must be turned off first). */
  savePending(userId: string, secretCiphertext: string): Promise<void>;
  /** Confirms the factor, replaces the recovery codes and verifies the session. */
  confirm(
    userId: string,
    step: number,
    codeHashes: string[],
    sessionId: string,
    meta: RequestMeta,
  ): Promise<void>;
  /** Accepts a TOTP step once (later than the last) and verifies the session; false if used. */
  useStep(userId: string, step: number, sessionId: string, meta: RequestMeta): Promise<boolean>;
  /** Uses a recovery code once and verifies the session; false if unknown or used. */
  useRecoveryCode(
    userId: string,
    codeHash: string,
    sessionId: string,
    meta: RequestMeta,
  ): Promise<boolean>;
  /** Removes the factor and codes and unverifies every session of the user. */
  disable(userId: string, meta: RequestMeta): Promise<void>;
}
export const MFA_STORE = Symbol('MFA_STORE');

/** The 32-byte key that seals TOTP secrets, or null when MFA is not set up. */
export const MFA_KEY = Symbol('MFA_KEY');

const VERIFY_LIMIT = { attempts: 10, windowMs: 15 * 60_000 };
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const wrongCode = () =>
  new ApiError(400, 'INVALID_MFA_CODE', 'That code is not right. Try the current one.');

/**
 * Multi-factor authentication (Phase 14 Part 2, ACCESS_CONTROL rule 7). People add an
 * authenticator app (TOTP) and get ten single-use recovery codes, shown once. A session becomes
 * verified when a current code or a recovery code is entered; privileged changes need a verified
 * session where enforcement is on (MfaPolicy). Verification attempts are rate limited.
 */
@Injectable()
export class MfaService {
  constructor(
    @Inject(MFA_STORE) private readonly store: MfaStore,
    @Inject(MFA_KEY) private readonly key: Buffer | null,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async status(principal: AuthenticatedPrincipal) {
    const factor = await this.store.factor(principal.userId);
    const enabled = factor?.confirmed === true;
    return {
      enabled,
      sessionVerified: enabled && principal.mfaVerified,
      recoveryCodesLeft: enabled ? await this.store.recoveryCodesLeft(principal.userId) : 0,
    };
  }

  async setup(principal: AuthenticatedPrincipal) {
    const key = this.requireKey();
    const existing = await this.store.factor(principal.userId);
    if (existing?.confirmed) {
      throw new ApiError(
        409,
        'MFA_ALREADY_ON',
        'Two-step sign-in is already on. Turn it off first.',
      );
    }
    const secret = newTotpSecret();
    await this.store.savePending(principal.userId, seal(key, secret));
    return { secret, otpauthUri: otpauthUri(secret, principal.email) };
  }

  async confirm(principal: AuthenticatedPrincipal, code: string, meta: RequestMeta) {
    const key = this.requireKey();
    await this.throttle(principal.userId);
    const factor = await this.store.factor(principal.userId);
    if (!factor || factor.confirmed) {
      throw new ApiError(
        409,
        'INVALID_STATE_TRANSITION',
        'Start setting up two-step sign-in first',
      );
    }
    const step = matchTotp(this.secretOf(key, factor), code, this.clock.now(), factor.lastUsedStep);
    if (step === null) throw wrongCode();
    const codes = newRecoveryCodes();
    await this.store.confirm(
      principal.userId,
      step,
      codes.map((c) => sha256(normaliseRecoveryCode(c))),
      principal.sessionId,
      meta,
    );
    return { recoveryCodes: codes };
  }

  async verify(
    principal: AuthenticatedPrincipal,
    input: { code?: string | undefined; recoveryCode?: string | undefined },
    meta: RequestMeta,
  ) {
    const key = this.requireKey();
    await this.throttle(principal.userId);
    const factor = await this.store.factor(principal.userId);
    if (!factor?.confirmed) {
      throw new ApiError(409, 'MFA_NOT_ON', 'Two-step sign-in is not on for this account');
    }
    if (input.recoveryCode) {
      const used = await this.store.useRecoveryCode(
        principal.userId,
        sha256(normaliseRecoveryCode(input.recoveryCode)),
        principal.sessionId,
        meta,
      );
      if (!used) throw wrongCode();
      return;
    }
    const step = matchTotp(
      this.secretOf(key, factor),
      input.code ?? '',
      this.clock.now(),
      factor.lastUsedStep,
    );
    if (
      step === null ||
      !(await this.store.useStep(principal.userId, step, principal.sessionId, meta))
    ) {
      throw wrongCode();
    }
  }

  async disable(principal: AuthenticatedPrincipal, code: string, meta: RequestMeta) {
    const key = this.requireKey();
    await this.throttle(principal.userId);
    const factor = await this.store.factor(principal.userId);
    if (!factor?.confirmed) {
      throw new ApiError(409, 'MFA_NOT_ON', 'Two-step sign-in is not on for this account');
    }
    if (!principal.mfaVerified) {
      throw new ApiError(403, 'MFA_REQUIRED', 'Confirm it is you with a code first');
    }
    const step = matchTotp(this.secretOf(key, factor), code, this.clock.now(), factor.lastUsedStep);
    if (step === null) throw wrongCode();
    await this.store.disable(principal.userId, meta);
  }

  private secretOf(key: Buffer, factor: MfaFactorRecord) {
    return base32Decode(open(key, factor.secretCiphertext));
  }

  private requireKey() {
    if (!this.key) {
      throw new ApiError(
        409,
        'MFA_NOT_CONFIGURED',
        'Two-step sign-in is not set up for this service',
      );
    }
    return this.key;
  }

  private async throttle(userId: string) {
    const hit = await this.limiter.hit(`mfa:user:${userId}`, VERIFY_LIMIT.windowMs);
    if (hit.count > VERIFY_LIMIT.attempts) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.');
    }
  }
}

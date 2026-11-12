import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../platform/clock';
import { ApiError } from '../../../platform/errors/api-error';
import { RATE_LIMITER, type RateLimiter } from '../../../platform/rate-limit/rate-limiter';
import type { SignInInput, SignUpInput } from '../domain/credentials';
import { initialExpiry, isSessionActive, refreshedIdleExpiry } from '../domain/session-policy';
import {
  generateSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
} from '../domain/session-token';
import type {
  AuthenticatedPrincipal,
  IdentityProvider,
  PresentedCredential,
} from './identity-provider';
import {
  EmailAlreadyRegisteredError,
  IDENTITY_REPOSITORY,
  type IdentityRepository,
  type IdentitySession,
  type IdentityUser,
  PASSWORD_HASHER,
  type PasswordHasher,
  type RequestMeta,
} from './ports';

const MINUTE = 60_000;

/** Abuse limits (ADR 0005). Counters live in Redis and are shared by all API instances. */
export const AUTH_RATE_LIMITS = {
  /** Every sign-in attempt from one IP address. */
  signInPerIp: { limit: 20, windowMs: 15 * MINUTE },
  /** Failed sign-ins for one email address, from any IP. */
  signInFailuresPerEmail: { limit: 5, windowMs: 15 * MINUTE },
  /** Sign-ups from one IP address. */
  signUpPerIp: { limit: 10, windowMs: 60 * MINUTE },
} as const;

export interface IssuedSession {
  user: IdentityUser;
  /** Returned to the client exactly once; only its hash is stored. */
  token: string;
  session: IdentitySession;
}

const INVALID_CREDENTIALS = () =>
  new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');

/**
 * Built-in email + password authentication with server-side sessions (ADR 0005). Implements the
 * IdentityProvider port for request authentication; sign-up and sign-in are specific to this
 * provider.
 */
@Injectable()
export class PasswordAuthService implements IdentityProvider {
  private readonly logger = new Logger(PasswordAuthService.name);
  private dummyHash: Promise<string> | undefined;

  constructor(
    @Inject(IDENTITY_REPOSITORY) private readonly repository: IdentityRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async signUp(input: SignUpInput, meta: RequestMeta): Promise<IssuedSession> {
    const ipCount = await this.limited(() =>
      this.limiter.hit(
        `signup:ip:${meta.ipAddress ?? 'unknown'}`,
        AUTH_RATE_LIMITS.signUpPerIp.windowMs,
      ),
    );
    if (ipCount.count > AUTH_RATE_LIMITS.signUpPerIp.limit)
      throw this.rateLimited(ipCount.resetInMs);

    const passwordHash = await this.hasher.hash(input.password);
    const token = generateSessionToken();
    const client = input.client === 'mobile' ? 'MOBILE' : 'WEB';
    try {
      const { user, session } = await this.repository.createUserWithSession(
        { email: input.email, displayName: input.displayName, passwordHash },
        { tokenHash: hashSessionToken(token), client, ...initialExpiry(client, this.clock.now()) },
        meta,
      );
      return { user, token, session };
    } catch (error) {
      if (error instanceof EmailAlreadyRegisteredError) {
        // Reveals that the address has an account. Accepted until email verification exists
        // (ADR 0005); sign-up is rate limited per IP to slow enumeration.
        throw new ApiError(
          409,
          'EMAIL_ALREADY_REGISTERED',
          'An account with this email already exists',
        );
      }
      throw error;
    }
  }

  async signIn(input: SignInInput, meta: RequestMeta): Promise<IssuedSession> {
    const ipCount = await this.limited(() =>
      this.limiter.hit(
        `signin:ip:${meta.ipAddress ?? 'unknown'}`,
        AUTH_RATE_LIMITS.signInPerIp.windowMs,
      ),
    );
    if (ipCount.count > AUTH_RATE_LIMITS.signInPerIp.limit)
      throw this.rateLimited(ipCount.resetInMs);

    // Keyed on a hash so email addresses are not stored in Redis.
    const emailKey = `signin:email:${createHash('sha256').update(input.email).digest('hex')}`;
    const failures = await this.limited(() => this.limiter.peek(emailKey));
    if (failures.count >= AUTH_RATE_LIMITS.signInFailuresPerEmail.limit) {
      throw this.rateLimited(failures.resetInMs);
    }

    const record = await this.repository.findUserWithPasswordByEmail(input.email);
    // Always run one hash verification so response time does not reveal whether the account exists.
    let passwordOk = false;
    if (record) {
      passwordOk = await this.hasher.verify(record.passwordHash, input.password);
    } else {
      await this.hasher.verify(await this.getDummyHash(), input.password);
    }

    if (!record || !passwordOk || record.user.status !== 'ACTIVE') {
      await this.limited(() =>
        this.limiter.hit(emailKey, AUTH_RATE_LIMITS.signInFailuresPerEmail.windowMs),
      );
      const reason = !record
        ? 'unknown_account'
        : !passwordOk
          ? 'wrong_password'
          : 'account_disabled';
      await this.repository.recordAudit(
        {
          action: 'auth.sign_in_failed',
          actorUserId: record?.user.id ?? null,
          resourceType: 'user',
          resourceId: record?.user.id ?? null,
          metadata: { reason },
        },
        meta,
      );
      throw INVALID_CREDENTIALS();
    }

    await this.limited(() => this.limiter.reset(emailKey));

    if (this.hasher.needsRehash(record.passwordHash)) {
      // Upgrades hashes transparently when the policy is strengthened.
      await this.repository.updatePasswordHash(
        record.user.id,
        await this.hasher.hash(input.password),
      );
    }

    const token = generateSessionToken();
    const client = input.client === 'mobile' ? 'MOBILE' : 'WEB';
    const session = await this.repository.createSession(
      record.user.id,
      { tokenHash: hashSessionToken(token), client, ...initialExpiry(client, this.clock.now()) },
      meta,
      {
        action: 'auth.sign_in',
        actorUserId: record.user.id,
        resourceType: 'session',
        resourceId: null,
        metadata: { client },
      },
    );
    return { user: record.user, token, session };
  }

  async authenticate(credential: PresentedCredential): Promise<AuthenticatedPrincipal | null> {
    if (!isWellFormedSessionToken(credential.token)) return null;
    const found = await this.repository.findSessionByTokenHash(hashSessionToken(credential.token));
    if (!found) return null;

    const { session, user } = found;
    const now = this.clock.now();
    // A token is valid only on the transport it was issued for.
    if (session.client !== credential.transport) return null;
    if (!isSessionActive(session, now)) return null;
    if (user.status !== 'ACTIVE') return null;

    const idleExpiresAt = refreshedIdleExpiry(session, now);
    if (idleExpiresAt) await this.repository.touchSession(session.id, now, idleExpiresAt);

    return {
      userId: user.id,
      sessionId: session.id,
      client: session.client,
      email: user.email,
      displayName: user.displayName,
      emailVerified: user.emailVerified,
      mfaEnabled: user.mfaEnabled,
      mfaVerified: user.mfaEnabled && session.mfaVerifiedAt !== null,
    };
  }

  async signOut(principal: AuthenticatedPrincipal, meta: RequestMeta): Promise<void> {
    await this.repository.revokeSession(principal.sessionId, this.clock.now(), meta, {
      action: 'auth.sign_out',
      actorUserId: principal.userId,
      resourceType: 'session',
      resourceId: principal.sessionId,
    });
  }

  /** A real hash with current parameters, so unknown-account checks cost the same as real ones. */
  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.hasher.hash(randomBytes(32).toString('base64url'));
    return this.dummyHash;
  }

  /** Fails closed: without the shared limiter, authentication endpoints are unavailable. */
  private async limited<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      this.logger.warn(
        `Rate limiter unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ApiError(
        503,
        'SERVICE_UNAVAILABLE',
        'Authentication is temporarily unavailable. Try again shortly.',
      );
    }
  }

  private rateLimited(resetInMs: number): ApiError {
    return new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.', {
      retryAfterSeconds: Math.max(1, Math.ceil(resetInMs / 1000)),
    });
  }
}

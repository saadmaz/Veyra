import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { accountEmail } from '@veyra/emails';
import { CLOCK, type Clock } from '../../../platform/clock';
import { ApiError } from '../../../platform/errors/api-error';
import { RATE_LIMITER, type RateLimiter } from '../../../platform/rate-limit/rate-limiter';
import { normaliseEmail } from '../domain/credentials';
import { PASSWORD_HASHER, type PasswordHasher, type RequestMeta } from './ports';

export type AccountTokenPurpose = 'VERIFY_EMAIL' | 'RESET_PASSWORD';

export interface AccountUser {
  id: string;
  email: string;
  displayName: string;
  status: 'ACTIVE' | 'DISABLED';
  emailVerified: boolean;
  hasPassword: boolean;
}

/** Persistence for account tokens. Every change writes its audit record in the same transaction. */
export interface AccountStore {
  findUserByEmail(email: string): Promise<AccountUser | null>;
  findUser(id: string): Promise<AccountUser | null>;
  /** Stores a new token and retires the user's unused ones of the same purpose. */
  issue(
    userId: string,
    purpose: AccountTokenPurpose,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<void>;
  /** The unused, unexpired token with this hash, or null. */
  findUsable(
    tokenHash: string,
    purpose: AccountTokenPurpose,
    now: Date,
  ): Promise<{ id: string; userId: string } | null>;
  /** Uses the token and confirms the email, once. */
  verifyEmail(tokenId: string, userId: string, meta: RequestMeta): Promise<void>;
  /** Uses the token, replaces the password and ends every session of the user. */
  resetPassword(
    tokenId: string,
    userId: string,
    passwordHash: string,
    meta: RequestMeta,
  ): Promise<void>;
}
export const ACCOUNT_STORE = Symbol('ACCOUNT_STORE');

/** The token was used by a concurrent request between lookup and use. */
export class AccountTokenUsedError extends Error {
  constructor() {
    super('Account token already used');
    this.name = 'AccountTokenUsedError';
  }
}

/** Sends one account email. Implementations never log the address or the link. */
export interface AccountMailer {
  send(message: {
    userId: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<void>;
}
export const ACCOUNT_MAILER = Symbol('ACCOUNT_MAILER');

/** Where links in account emails point. */
export const CONSOLE_BASE_URL = Symbol('CONSOLE_BASE_URL');

const VERIFY_HOURS = 24;
const RESET_MINUTES = 60;
const RESET_LIMIT = { perEmail: 3, perIp: 20, windowMs: 60 * 60_000 };
const RESEND_LIMIT = { perUser: 5, windowMs: 60 * 60_000 };

const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
const WELL_FORMED = /^[A-Za-z0-9_-]{43}$/;

const invalidLink = () =>
  new ApiError(
    400,
    'INVALID_OR_EXPIRED_LINK',
    'This link is invalid or has expired. Ask for a new one.',
  );

/**
 * Email verification and password reset (Phase 14 Part 1, ADR 0005). Tokens are 256 random bits,
 * emailed as links and stored only as their SHA-256; each is used once and expires (a day to
 * verify, an hour to reset). Asking for a reset never reveals whether an account exists. A reset
 * ends every session of the account.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @Inject(ACCOUNT_STORE) private readonly store: AccountStore,
    @Inject(ACCOUNT_MAILER) private readonly mailer: AccountMailer,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONSOLE_BASE_URL) private readonly consoleUrl: string,
  ) {}

  /** After sign-up: send the confirmation link. A mail failure never fails the sign-up. */
  async welcome(userId: string) {
    const user = await this.store.findUser(userId);
    if (user && !user.emailVerified) await this.send(user, 'VERIFY_EMAIL').catch(() => undefined);
  }

  async resendVerification(userId: string) {
    const hit = await this.limiter.hit(`verify:user:${userId}`, RESEND_LIMIT.windowMs);
    if (hit.count > RESEND_LIMIT.perUser) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many emails. Try again later.');
    }
    const user = await this.store.findUser(userId);
    if (!user || user.emailVerified) return;
    await this.send(user, 'VERIFY_EMAIL');
  }

  async verifyEmail(token: string, meta: RequestMeta) {
    const found = await this.usable(token, 'VERIFY_EMAIL');
    await this.once(this.store.verifyEmail(found.id, found.userId, meta));
  }

  /** Always succeeds from the caller's view, so it cannot tell who has an account. */
  async requestReset(email: string, meta: RequestMeta) {
    const normalised = normaliseEmail(email);
    const [byIp, byEmail] = await Promise.all([
      this.limiter.hit(`reset:ip:${meta.ipAddress ?? 'unknown'}`, RESET_LIMIT.windowMs),
      this.limiter.hit(`reset:email:${hashToken(normalised)}`, RESET_LIMIT.windowMs),
    ]);
    if (byIp.count > RESET_LIMIT.perIp) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Try again later.');
    }
    if (byEmail.count > RESET_LIMIT.perEmail) return;
    const user = await this.store.findUserByEmail(normalised);
    if (user?.status !== 'ACTIVE' || !user.hasPassword) return;
    await this.send(user, 'RESET_PASSWORD').catch((error: unknown) => {
      this.logger.warn(`Reset email not sent: ${error instanceof Error ? error.message : 'error'}`);
    });
  }

  async confirmReset(token: string, password: string, meta: RequestMeta) {
    const found = await this.usable(token, 'RESET_PASSWORD');
    const passwordHash = await this.hasher.hash(password);
    await this.once(this.store.resetPassword(found.id, found.userId, passwordHash, meta));
  }

  private async once(work: Promise<void>) {
    try {
      await work;
    } catch (error) {
      if (error instanceof AccountTokenUsedError) throw invalidLink();
      throw error;
    }
  }

  private async usable(token: string, purpose: AccountTokenPurpose) {
    if (!WELL_FORMED.test(token)) throw invalidLink();
    const found = await this.store.findUsable(hashToken(token), purpose, this.clock.now());
    if (!found) throw invalidLink();
    return found;
  }

  private async send(user: AccountUser, purpose: AccountTokenPurpose) {
    const token = randomBytes(32).toString('base64url');
    const now = this.clock.now();
    const expiresAt = new Date(
      now.getTime() +
        (purpose === 'VERIFY_EMAIL' ? VERIFY_HOURS * 3_600_000 : RESET_MINUTES * 60_000),
    );
    await this.store.issue(user.id, purpose, hashToken(token), expiresAt);
    const path = purpose === 'VERIFY_EMAIL' ? 'verify-email' : 'reset-password';
    const email = accountEmail({
      kind: purpose === 'VERIFY_EMAIL' ? 'verify-email' : 'reset-password',
      displayName: user.displayName,
      url: `${this.consoleUrl}/${path}#token=${token}`,
      expiresAt,
    });
    await this.mailer.send({ userId: user.id, to: user.email, ...email });
  }
}

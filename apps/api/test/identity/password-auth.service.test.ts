import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH_RATE_LIMITS,
  PasswordAuthService,
} from '../../src/modules/identity/application/password-auth.service';
import {
  type AuditEvent,
  EmailAlreadyRegisteredError,
  type IdentityRepository,
  type IdentitySession,
  type IdentityUser,
  type NewSession,
  type PasswordHasher,
  type RequestMeta,
} from '../../src/modules/identity/application/ports';
import { ApiError } from '../../src/platform/errors/api-error';
import { InMemoryRateLimiter } from '../support/in-memory-rate-limiter';

const MINUTE = 60_000;

class FakeHasher implements PasswordHasher {
  verifyCalls: string[] = [];
  weak = new Set<string>();
  async hash(password: string) {
    return `hashed:${password}:${randomUUID()}`;
  }
  async verify(passwordHash: string, password: string) {
    this.verifyCalls.push(passwordHash);
    return passwordHash.startsWith(`hashed:${password}:`);
  }
  needsRehash(passwordHash: string) {
    return this.weak.has(passwordHash);
  }
}

class FakeRepository implements IdentityRepository {
  users = new Map<string, IdentityUser & { passwordHash: string }>();
  sessions = new Map<string, IdentitySession & { tokenHash: string }>();
  audit: AuditEvent[] = [];
  constructor(private readonly clock: { now(): Date }) {}

  async createUserWithSession(
    user: { email: string; displayName: string; passwordHash: string },
    session: NewSession,
    meta: RequestMeta,
  ) {
    if ([...this.users.values()].some((u) => u.email === user.email)) {
      throw new EmailAlreadyRegisteredError();
    }
    const created = {
      id: randomUUID(),
      status: 'ACTIVE' as const,
      emailVerified: false,
      mfaEnabled: false,
      ...user,
    };
    this.users.set(created.id, created);
    const createdSession = await this.createSession(created.id, session, meta, {
      action: 'auth.sign_up',
      actorUserId: created.id,
      resourceType: 'user',
      resourceId: created.id,
    });
    return { user: this.publicUser(created), session: createdSession };
  }
  async findUserWithPasswordByEmail(email: string) {
    const user = [...this.users.values()].find((u) => u.email === email);
    return user ? { user: this.publicUser(user), passwordHash: user.passwordHash } : null;
  }
  async createSession(userId: string, session: NewSession, _meta: RequestMeta, audit: AuditEvent) {
    const created = {
      id: randomUUID(),
      userId,
      lastSeenAt: this.clock.now(),
      revokedAt: null,
      mfaVerifiedAt: null,
      ...session,
    };
    this.sessions.set(created.id, created);
    this.audit.push(audit);
    const { tokenHash: _hash, ...rest } = created;
    return rest;
  }
  async updatePasswordHash(userId: string, passwordHash: string) {
    const user = this.users.get(userId);
    if (user) user.passwordHash = passwordHash;
  }
  async findSessionByTokenHash(tokenHash: string) {
    const session = [...this.sessions.values()].find((s) => s.tokenHash === tokenHash);
    const user = session && this.users.get(session.userId);
    if (!session || !user) return null;
    const { tokenHash: _hash, ...rest } = session;
    return { session: { ...rest }, user: this.publicUser(user) };
  }
  async touchSession(sessionId: string, lastSeenAt: Date, idleExpiresAt: Date) {
    const session = this.sessions.get(sessionId);
    if (session && !session.revokedAt) Object.assign(session, { lastSeenAt, idleExpiresAt });
  }
  async revokeSession(sessionId: string, revokedAt: Date, _meta: RequestMeta, audit: AuditEvent) {
    const session = this.sessions.get(sessionId);
    if (session && !session.revokedAt) {
      session.revokedAt = revokedAt;
      this.audit.push(audit);
    }
  }
  async recordAudit(event: AuditEvent) {
    this.audit.push(event);
  }
  private publicUser({ passwordHash: _hash, ...user }: IdentityUser & { passwordHash: string }) {
    return user;
  }
}

const meta: RequestMeta = { ipAddress: '203.0.113.7', userAgent: 'test', requestId: 'req-1' };
const signUpInput = {
  email: 'resident@example.test',
  password: 'correct horse battery',
  displayName: 'Resident',
  client: 'web' as const,
};
const signIn = (password = signUpInput.password, client: 'web' | 'mobile' = 'web') => ({
  email: signUpInput.email,
  password,
  client,
});

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status, code });
  return error as ApiError;
}

describe('PasswordAuthService', () => {
  let nowMs: number;
  const clock = { now: () => new Date(nowMs) };
  let repository: FakeRepository;
  let hasher: FakeHasher;
  let limiter: InMemoryRateLimiter;
  let service: PasswordAuthService;

  beforeEach(() => {
    nowMs = Date.parse('2026-11-08T10:00:00Z');
    repository = new FakeRepository(clock);
    hasher = new FakeHasher();
    limiter = new InMemoryRateLimiter(() => nowMs);
    service = new PasswordAuthService(repository, hasher, limiter, clock);
  });

  describe('sign-up', () => {
    it('creates the user and a session, returning a token that is stored only as a hash', async () => {
      const issued = await service.signUp(signUpInput, meta);
      expect(issued.user.email).toBe('resident@example.test');
      const stored = [...repository.sessions.values()][0];
      expect(stored?.tokenHash).not.toBe(issued.token);
      expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(repository.audit.map((a) => a.action)).toEqual(['auth.sign_up']);
    });

    it('reports an already registered email as a 409', async () => {
      await service.signUp(signUpInput, meta);
      await expectApiError(service.signUp(signUpInput, meta), 409, 'EMAIL_ALREADY_REGISTERED');
    });

    it('limits sign-ups per IP address', async () => {
      for (let i = 0; i < AUTH_RATE_LIMITS.signUpPerIp.limit; i++) {
        await service.signUp({ ...signUpInput, email: `user${i}@example.test` }, meta);
      }
      const error = await expectApiError(
        service.signUp({ ...signUpInput, email: 'one-more@example.test' }, meta),
        429,
        'RATE_LIMITED',
      );
      expect(error.options.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  describe('sign-in', () => {
    beforeEach(async () => {
      await service.signUp(signUpInput, meta);
      repository.audit = [];
    });

    it('issues a new session for the right password', async () => {
      const issued = await service.signIn(signIn(), meta);
      expect(issued.session.client).toBe('WEB');
      expect(repository.audit.map((a) => a.action)).toEqual(['auth.sign_in']);
    });

    it('gives the same error for a wrong password and an unknown account', async () => {
      const wrong = await expectApiError(
        service.signIn(signIn('wrong password!'), meta),
        401,
        'INVALID_CREDENTIALS',
      );
      const unknown = await expectApiError(
        service.signIn({ ...signIn(), email: 'nobody@example.test' }, meta),
        401,
        'INVALID_CREDENTIALS',
      );
      expect(unknown.message).toBe(wrong.message);
      expect(repository.audit.map((a) => a.metadata?.reason)).toEqual([
        'wrong_password',
        'unknown_account',
      ]);
    });

    it('still runs a password verification for unknown accounts (timing)', async () => {
      hasher.verifyCalls = [];
      await expectApiError(
        service.signIn({ ...signIn(), email: 'nobody@example.test' }, meta),
        401,
        'INVALID_CREDENTIALS',
      );
      expect(hasher.verifyCalls).toHaveLength(1);
    });

    it('refuses disabled accounts with the generic error, even with the right password', async () => {
      for (const user of repository.users.values()) user.status = 'DISABLED';
      await expectApiError(service.signIn(signIn(), meta), 401, 'INVALID_CREDENTIALS');
      expect(repository.audit.at(-1)?.metadata?.reason).toBe('account_disabled');
    });

    it('blocks an email after 5 failures, even with the right password, until the window ends', async () => {
      for (let i = 0; i < AUTH_RATE_LIMITS.signInFailuresPerEmail.limit; i++) {
        await expectApiError(
          service.signIn(signIn('wrong password!'), meta),
          401,
          'INVALID_CREDENTIALS',
        );
      }
      // From another IP too: the counter is per email.
      await expectApiError(
        service.signIn(signIn(), { ...meta, ipAddress: '198.51.100.1' }),
        429,
        'RATE_LIMITED',
      );
      nowMs += AUTH_RATE_LIMITS.signInFailuresPerEmail.windowMs;
      await expect(service.signIn(signIn(), meta)).resolves.toBeDefined();
    });

    it('clears the failure counter after a successful sign-in', async () => {
      for (let i = 0; i < 4; i++) {
        await expectApiError(
          service.signIn(signIn('wrong password!'), meta),
          401,
          'INVALID_CREDENTIALS',
        );
      }
      await service.signIn(signIn(), meta);
      await expectApiError(
        service.signIn(signIn('wrong password!'), meta),
        401,
        'INVALID_CREDENTIALS',
      );
      await expect(service.signIn(signIn(), meta)).resolves.toBeDefined();
    });

    it('limits attempts per IP address across accounts', async () => {
      for (let i = 0; i < AUTH_RATE_LIMITS.signInPerIp.limit; i++) {
        await expectApiError(
          service.signIn({ ...signIn(), email: `probe${i}@example.test` }, meta),
          401,
          'INVALID_CREDENTIALS',
        );
      }
      await expectApiError(service.signIn(signIn(), meta), 429, 'RATE_LIMITED');
    });

    it('fails closed when the rate limiter is unavailable', async () => {
      limiter.failing = true;
      await expectApiError(service.signIn(signIn(), meta), 503, 'SERVICE_UNAVAILABLE');
      await expectApiError(
        service.signUp({ ...signUpInput, email: 'new@example.test' }, meta),
        503,
        'SERVICE_UNAVAILABLE',
      );
    });

    it('upgrades a weak password hash on successful sign-in', async () => {
      const user = [...repository.users.values()][0];
      if (!user) throw new Error('fixture missing');
      const old = user.passwordHash;
      hasher.weak.add(old);
      await service.signIn(signIn(), meta);
      expect(user.passwordHash).not.toBe(old);
      expect(await hasher.verify(user.passwordHash, signUpInput.password)).toBe(true);
    });
  });

  describe('authenticate', () => {
    it('accepts a valid token only on the transport it was issued for', async () => {
      const web = await service.signUp(signUpInput, meta);
      expect(await service.authenticate({ token: web.token, transport: 'WEB' })).toMatchObject({
        userId: web.user.id,
        client: 'WEB',
      });
      expect(await service.authenticate({ token: web.token, transport: 'MOBILE' })).toBeNull();

      const mobile = await service.signIn(signIn(undefined, 'mobile'), meta);
      expect(
        await service.authenticate({ token: mobile.token, transport: 'MOBILE' }),
      ).not.toBeNull();
      expect(await service.authenticate({ token: mobile.token, transport: 'WEB' })).toBeNull();
    });

    it('rejects unknown and malformed tokens', async () => {
      await service.signUp(signUpInput, meta);
      expect(await service.authenticate({ token: 'A'.repeat(43), transport: 'WEB' })).toBeNull();
      expect(await service.authenticate({ token: 'nope', transport: 'WEB' })).toBeNull();
    });

    it('rejects idle sessions and slides the idle expiry on activity', async () => {
      const { token } = await service.signUp(signUpInput, meta);
      nowMs += 20 * MINUTE;
      expect(await service.authenticate({ token, transport: 'WEB' })).not.toBeNull();
      nowMs += 20 * MINUTE; // 40 minutes after sign-in, 20 after last activity
      expect(await service.authenticate({ token, transport: 'WEB' })).not.toBeNull();
      nowMs += 31 * MINUTE; // idle too long
      expect(await service.authenticate({ token, transport: 'WEB' })).toBeNull();
    });

    it('rejects sessions past the absolute expiry despite constant activity', async () => {
      const { token } = await service.signUp(signUpInput, meta);
      for (let elapsed = 0; elapsed < 7 * 24 * 60; elapsed += 20) {
        nowMs += 20 * MINUTE;
        if (!(await service.authenticate({ token, transport: 'WEB' }))) break;
      }
      expect(nowMs - Date.parse('2026-11-08T10:00:00Z')).toBeLessThanOrEqual(
        7 * 24 * 60 * MINUTE + 20 * MINUTE,
      );
      expect(await service.authenticate({ token, transport: 'WEB' })).toBeNull();
    });

    it('rejects sessions of a user disabled after sign-in', async () => {
      const { token } = await service.signUp(signUpInput, meta);
      for (const user of repository.users.values()) user.status = 'DISABLED';
      expect(await service.authenticate({ token, transport: 'WEB' })).toBeNull();
    });

    it('rejects a session after sign-out, and audits the sign-out once', async () => {
      const { token } = await service.signUp(signUpInput, meta);
      const principal = await service.authenticate({ token, transport: 'WEB' });
      if (!principal) throw new Error('expected a principal');
      await service.signOut(principal, meta);
      await service.signOut(principal, meta);
      expect(await service.authenticate({ token, transport: 'WEB' })).toBeNull();
      expect(repository.audit.filter((a) => a.action === 'auth.sign_out')).toHaveLength(1);
    });
  });
});

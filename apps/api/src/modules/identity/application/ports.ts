import type { SessionClientType, SessionState } from '../domain/session-policy';

/** Hashes and verifies passwords. Implementation: argon2id (ADR 0005). */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
  /** True when a stored hash uses weaker parameters than the current policy. */
  needsRehash(passwordHash: string): boolean;
}
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

export type UserStatus = 'ACTIVE' | 'DISABLED';

export interface IdentityUser {
  id: string;
  email: string;
  displayName: string;
  status: UserStatus;
  emailVerified: boolean;
}

export interface IdentitySession extends SessionState {
  id: string;
  userId: string;
}

/** Where a request came from. Recorded on sessions and audit records; never trusted for auth. */
export interface RequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export interface NewSession {
  tokenHash: string;
  client: SessionClientType;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
}

export interface AuditEvent {
  action: string;
  actorUserId: string | null;
  resourceType: string;
  resourceId: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

/** Signals that the email is already registered (including a concurrent sign-up). */
export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super('Email already registered');
    this.name = 'EmailAlreadyRegisteredError';
  }
}

/**
 * Persistence for users, credentials and sessions. Every state change writes its audit record
 * in the same transaction, so an audited action cannot happen without its record.
 */
export interface IdentityRepository {
  /** Throws EmailAlreadyRegisteredError if the email exists. */
  createUserWithSession(
    user: { email: string; displayName: string; passwordHash: string },
    session: NewSession,
    meta: RequestMeta,
  ): Promise<{ user: IdentityUser; session: IdentitySession }>;

  findUserWithPasswordByEmail(
    email: string,
  ): Promise<{ user: IdentityUser; passwordHash: string } | null>;

  createSession(
    userId: string,
    session: NewSession,
    meta: RequestMeta,
    audit: AuditEvent,
  ): Promise<IdentitySession>;

  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;

  findSessionByTokenHash(
    tokenHash: string,
  ): Promise<{ session: IdentitySession; user: IdentityUser } | null>;

  /** Extends the idle expiry. Does nothing if the session was revoked meanwhile. */
  touchSession(sessionId: string, lastSeenAt: Date, idleExpiresAt: Date): Promise<void>;

  revokeSession(
    sessionId: string,
    revokedAt: Date,
    meta: RequestMeta,
    audit: AuditEvent,
  ): Promise<void>;

  recordAudit(event: AuditEvent, meta: RequestMeta): Promise<void>;
}
export const IDENTITY_REPOSITORY = Symbol('IDENTITY_REPOSITORY');

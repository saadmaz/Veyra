import { Inject, Injectable } from '@nestjs/common';
import {
  type DbClient,
  type DbTransaction,
  isUniqueViolation,
  type SessionRow,
  type UserRow,
} from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import {
  type AuditEvent,
  EmailAlreadyRegisteredError,
  type IdentityRepository,
  type IdentitySession,
  type IdentityUser,
  type NewSession,
  type RequestMeta,
} from '../application/ports';

const toUser = (row: UserRow): IdentityUser => ({
  id: row.id,
  email: row.email,
  displayName: row.displayName,
  status: row.status,
  emailVerified: row.emailVerifiedAt !== null,
});

const toSession = (row: SessionRow): IdentitySession => ({
  id: row.id,
  userId: row.userId,
  client: row.client,
  lastSeenAt: row.lastSeenAt,
  idleExpiresAt: row.idleExpiresAt,
  absoluteExpiresAt: row.absoluteExpiresAt,
  revokedAt: row.revokedAt,
});

/** Request metadata is untrusted input: bound its size before storing it. */
const clip = (value: string | null, max: number): string | null =>
  value === null ? null : value.slice(0, max);

/**
 * Identity tables (users, password_credentials, sessions) are global, not tenant-owned, so
 * these queries run without tenant context. Audit records are platform events
 * (organisation_id NULL). They are inserted with createMany because a single-row create uses
 * INSERT ... RETURNING, and RLS hides platform audit rows from every reader, including the
 * writer.
 */
@Injectable()
export class PrismaIdentityRepository implements IdentityRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async createUserWithSession(
    user: { email: string; displayName: string; passwordHash: string },
    session: NewSession,
    meta: RequestMeta,
  ): Promise<{ user: IdentityUser; session: IdentitySession }> {
    try {
      return await this.db.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: user.email,
            displayName: user.displayName,
            passwordCredential: { create: { passwordHash: user.passwordHash } },
          },
        });
        const createdSession = await this.insertSession(tx, created.id, session, meta);
        await this.insertAudit(
          tx,
          {
            action: 'auth.sign_up',
            actorUserId: created.id,
            resourceType: 'user',
            resourceId: created.id,
            metadata: { client: session.client },
          },
          meta,
        );
        return { user: toUser(created), session: createdSession };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'email')) throw new EmailAlreadyRegisteredError();
      throw error;
    }
  }

  async findUserWithPasswordByEmail(
    email: string,
  ): Promise<{ user: IdentityUser; passwordHash: string } | null> {
    const row = await this.db.user.findUnique({
      where: { email },
      include: { passwordCredential: true },
    });
    if (!row?.passwordCredential) return null;
    return { user: toUser(row), passwordHash: row.passwordCredential.passwordHash };
  }

  createSession(
    userId: string,
    session: NewSession,
    meta: RequestMeta,
    audit: AuditEvent,
  ): Promise<IdentitySession> {
    return this.db.$transaction(async (tx) => {
      const created = await this.insertSession(tx, userId, session, meta);
      await this.insertAudit(tx, { ...audit, resourceId: created.id }, meta);
      return created;
    });
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.db.passwordCredential.update({ where: { userId }, data: { passwordHash } });
  }

  async findSessionByTokenHash(
    tokenHash: string,
  ): Promise<{ session: IdentitySession; user: IdentityUser } | null> {
    const row = await this.db.session.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!row) return null;
    return { session: toSession(row), user: toUser(row.user) };
  }

  async touchSession(sessionId: string, lastSeenAt: Date, idleExpiresAt: Date): Promise<void> {
    await this.db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { lastSeenAt, idleExpiresAt },
    });
  }

  async revokeSession(
    sessionId: string,
    revokedAt: Date,
    meta: RequestMeta,
    audit: AuditEvent,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const { count } = await tx.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt },
      });
      if (count > 0) await this.insertAudit(tx, audit, meta);
    });
  }

  async recordAudit(event: AuditEvent, meta: RequestMeta): Promise<void> {
    await this.insertAudit(this.db, event, meta);
  }

  private async insertSession(
    tx: DbTransaction,
    userId: string,
    session: NewSession,
    meta: RequestMeta,
  ): Promise<IdentitySession> {
    const row = await tx.session.create({
      data: {
        userId,
        tokenHash: session.tokenHash,
        client: session.client,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
        ipAddress: clip(meta.ipAddress, 64),
        userAgent: clip(meta.userAgent, 512),
      },
    });
    return toSession(row);
  }

  private async insertAudit(
    executor: DbTransaction | DbClient,
    event: AuditEvent,
    meta: RequestMeta,
  ): Promise<void> {
    await executor.auditLog.createMany({
      data: [
        {
          organisationId: null,
          actorUserId: event.actorUserId,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          metadata: event.metadata ?? {},
          requestId: clip(meta.requestId, 128),
          ipAddress: clip(meta.ipAddress, 64),
        },
      ],
    });
  }
}

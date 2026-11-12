import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DbClient, DbTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import {
  type AccountMailer,
  type AccountStore,
  type AccountTokenPurpose,
  AccountTokenUsedError,
  type AccountUser,
} from '../application/account.service';
import type { RequestMeta } from '../application/ports';

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

const USER = {
  id: true,
  email: true,
  displayName: true,
  status: true,
  emailVerifiedAt: true,
  passwordCredential: { select: { userId: true } },
} as const;

type Row = {
  id: string;
  email: string;
  displayName: string;
  status: 'ACTIVE' | 'DISABLED';
  emailVerifiedAt: Date | null;
  passwordCredential: { userId: string } | null;
};

const toUser = (r: Row): AccountUser => ({
  id: r.id,
  email: r.email,
  displayName: r.displayName,
  status: r.status,
  emailVerified: r.emailVerifiedAt !== null,
  hasPassword: r.passwordCredential !== null,
});

async function audit(tx: DbTransaction, action: string, userId: string, meta: RequestMeta) {
  await tx.auditLog.createMany({
    data: [
      {
        organisationId: null,
        actorUserId: userId,
        action,
        resourceType: 'user',
        resourceId: userId,
        metadata: {},
        requestId: clip(meta.requestId, 128),
        ipAddress: clip(meta.ipAddress, 64),
      },
    ],
  });
}

/** Account tokens over Prisma (identity tables are global, not tenant data). */
@Injectable()
export class PrismaAccountStore implements AccountStore {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async findUserByEmail(email: string) {
    const row = await this.db.user.findUnique({ where: { email }, select: USER });
    return row ? toUser(row as Row) : null;
  }

  async findUser(id: string) {
    const row = await this.db.user.findUnique({ where: { id }, select: USER });
    return row ? toUser(row as Row) : null;
  }

  async issue(userId: string, purpose: AccountTokenPurpose, tokenHash: string, expiresAt: Date) {
    await this.db.$transaction(async (tx) => {
      // Earlier unused links of the same kind stop working: only the newest counts.
      await tx.accountToken.updateMany({
        where: { userId, purpose, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.accountToken.create({ data: { userId, purpose, tokenHash, expiresAt } });
    });
  }

  async findUsable(tokenHash: string, purpose: AccountTokenPurpose, now: Date) {
    return this.db.accountToken.findFirst({
      where: { tokenHash, purpose, usedAt: null, expiresAt: { gt: now } },
      select: { id: true, userId: true },
    });
  }

  async verifyEmail(tokenId: string, userId: string, meta: RequestMeta) {
    await this.db.$transaction(async (tx) => {
      await this.use(tx, tokenId);
      await tx.user.updateMany({
        where: { id: userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: new Date() },
      });
      await audit(tx, 'auth.email_verified', userId, meta);
    });
  }

  async resetPassword(tokenId: string, userId: string, passwordHash: string, meta: RequestMeta) {
    await this.db.$transaction(async (tx) => {
      await this.use(tx, tokenId);
      await tx.passwordCredential.update({ where: { userId }, data: { passwordHash } });
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // Following a reset link proves control of the address too.
      await tx.user.updateMany({
        where: { id: userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: new Date() },
      });
      await audit(tx, 'auth.password_reset', userId, meta);
    });
  }

  /** Marks a token used; a concurrent use of the same token finds nothing to update. */
  private async use(tx: DbTransaction, tokenId: string) {
    const { count } = await tx.accountToken.updateMany({
      where: { id: tokenId, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (count !== 1) throw new AccountTokenUsedError();
  }
}

/**
 * Development and test mailer: logs that an email was sent, never the address. Outside
 * production it also logs the link so a developer can follow it (there is no inbox locally).
 */
@Injectable()
export class LogAccountMailer implements AccountMailer {
  private readonly logger = new Logger('AccountMailer');

  constructor(private readonly showLinks: boolean) {}

  async send(message: { userId: string; subject: string; text: string }) {
    this.logger.log(`[email:log] "${message.subject}" for user ${message.userId}`);
    if (this.showLinks) {
      const link = /https?:\/\/\S+/.exec(message.text)?.[0];
      if (link) this.logger.log(`[email:log] development link: ${link}`);
    }
  }
}

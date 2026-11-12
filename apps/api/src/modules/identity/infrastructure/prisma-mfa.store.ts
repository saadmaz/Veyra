import { Inject, Injectable } from '@nestjs/common';
import type { DbClient, DbTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { MfaStore } from '../application/mfa.service';
import type { RequestMeta } from '../application/ports';

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

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

/** MFA factors and recovery codes over Prisma (identity tables are global, not tenant data). */
@Injectable()
export class PrismaMfaStore implements MfaStore {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  async factor(userId: string) {
    const row = await this.db.mfaFactor.findUnique({ where: { userId } });
    return row
      ? {
          secretCiphertext: row.secretCiphertext,
          confirmed: row.confirmedAt !== null,
          lastUsedStep: row.lastUsedStep === null ? null : Number(row.lastUsedStep),
        }
      : null;
  }

  recoveryCodesLeft(userId: string): Promise<number> {
    return this.db.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
  }

  async savePending(userId: string, secretCiphertext: string) {
    await this.db.$transaction(async (tx) => {
      await tx.mfaFactor.deleteMany({ where: { userId, confirmedAt: null } });
      await tx.mfaFactor.create({ data: { userId, secretCiphertext } });
    });
  }

  async confirm(
    userId: string,
    step: number,
    codeHashes: string[],
    sessionId: string,
    meta: RequestMeta,
  ) {
    await this.db.$transaction(async (tx) => {
      await tx.mfaFactor.update({
        where: { userId },
        data: { confirmedAt: new Date(), lastUsedStep: BigInt(step) },
      });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.mfaRecoveryCode.createMany({
        data: codeHashes.map((codeHash) => ({ userId, codeHash })),
      });
      await tx.session.updateMany({
        where: { id: sessionId, userId },
        data: { mfaVerifiedAt: new Date() },
      });
      await audit(tx, 'auth.mfa_enabled', userId, meta);
    });
  }

  async useStep(userId: string, step: number, sessionId: string, meta: RequestMeta) {
    return this.db.$transaction(async (tx) => {
      const { count } = await tx.mfaFactor.updateMany({
        where: {
          userId,
          confirmedAt: { not: null },
          OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(step) } }],
        },
        data: { lastUsedStep: BigInt(step) },
      });
      if (count !== 1) return false;
      await tx.session.updateMany({
        where: { id: sessionId, userId },
        data: { mfaVerifiedAt: new Date() },
      });
      await audit(tx, 'auth.mfa_verified', userId, meta);
      return true;
    });
  }

  async useRecoveryCode(userId: string, codeHash: string, sessionId: string, meta: RequestMeta) {
    return this.db.$transaction(async (tx) => {
      const { count } = await tx.mfaRecoveryCode.updateMany({
        where: { userId, codeHash, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (count !== 1) return false;
      await tx.session.updateMany({
        where: { id: sessionId, userId },
        data: { mfaVerifiedAt: new Date() },
      });
      await audit(tx, 'auth.mfa_recovery_code_used', userId, meta);
      return true;
    });
  }

  async disable(userId: string, meta: RequestMeta) {
    await this.db.$transaction(async (tx) => {
      await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.mfaFactor.deleteMany({ where: { userId } });
      await tx.session.updateMany({ where: { userId }, data: { mfaVerifiedAt: null } });
      await audit(tx, 'auth.mfa_disabled', userId, meta);
    });
  }
}

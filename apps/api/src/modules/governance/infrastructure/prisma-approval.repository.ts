import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, type DbTransaction, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import type { TransactionHandle } from '../../../platform/transaction-handle';
import type {
  ApprovalRepository,
  ApprovalRequestRecord,
  ApprovalUnitOfWork,
  PolicyRecord,
} from '../application/approval-ports';

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

const POLICY = {
  id: true,
  requestType: true,
  minAmountMinor: true,
  requiredApprovals: true,
  approvers: true,
  committeeId: true,
  committee: { select: { name: true } },
  active: true,
  createdAt: true,
} as const;

const REQUEST = {
  id: true,
  requestNumber: true,
  requestType: true,
  title: true,
  description: true,
  amountMinor: true,
  currency: true,
  document: { select: { id: true, title: true } },
  requiredApprovals: true,
  approvers: true,
  committee: { select: { id: true, name: true } },
  status: true,
  requestedByUserId: true,
  requestedBy: { select: { displayName: true } },
  decidedAt: true,
  createdAt: true,
  decisions: {
    select: {
      userId: true,
      user: { select: { displayName: true } },
      decision: true,
      note: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as const;

type PolicyRow = Omit<PolicyRecord, 'committeeName'> & { committee: { name: string } | null };
const toPolicy = ({ committee, ...row }: PolicyRow): PolicyRecord => ({
  ...row,
  committeeName: committee?.name ?? null,
});

type RequestRow = Omit<ApprovalRequestRecord, 'number' | 'requestedByName' | 'decisions'> & {
  requestNumber: bigint | null;
  requestedBy: { displayName: string };
  decisions: {
    userId: string;
    user: { displayName: string };
    decision: 'APPROVE' | 'REJECT';
    note: string | null;
    createdAt: Date;
  }[];
};
const toRequest = ({
  requestNumber,
  requestedBy,
  decisions,
  ...row
}: RequestRow): ApprovalRequestRecord => ({
  ...row,
  currency: row.currency?.trim() ?? null,
  number: Number(requestNumber ?? 0),
  requestedByName: requestedBy.displayName,
  decisions: decisions.map(({ user, ...d }) => ({ ...d, name: user.displayName })),
});

class PrismaApprovalUnitOfWork implements ApprovalUnitOfWork {
  private readonly scope: { organisationId: string; propertyId: string };

  constructor(
    private readonly tx: DbTransaction,
    private readonly organisationId: string,
    private readonly propertyId: string,
    private readonly userId: string,
    private readonly meta: RequestMeta,
  ) {
    this.scope = { organisationId, propertyId };
  }

  transaction(): TransactionHandle {
    return this.tx as unknown as TransactionHandle;
  }

  async currency() {
    const row = await this.tx.property.findFirst({
      where: { id: this.propertyId, organisationId: this.organisationId },
      select: { currency: true },
    });
    if (!row) throw new Error('Property vanished inside its own transaction');
    return row.currency.trim();
  }

  async today() {
    const rows = await this.tx.$queryRaw<{ today: string }[]>`
      SELECT to_char((now() AT TIME ZONE "time_zone")::date, 'YYYY-MM-DD') AS today
        FROM "properties" WHERE "id" = ${this.propertyId}::uuid AND "organisation_id" = ${this.organisationId}::uuid`;
    const today = rows[0]?.today;
    if (!today) throw new Error('Property vanished inside its own transaction');
    return today;
  }

  async policies() {
    const rows = await this.tx.approvalPolicy.findMany({
      where: this.scope,
      select: POLICY,
      orderBy: [{ requestType: 'asc' }, { minAmountMinor: 'asc' }],
    });
    return rows.map(toPolicy);
  }

  async policy(id: string) {
    const row = await this.tx.approvalPolicy.findFirst({
      where: { ...this.scope, id },
      select: POLICY,
    });
    return row ? toPolicy(row) : null;
  }

  async createPolicy(input: Parameters<ApprovalUnitOfWork['createPolicy']>[0]) {
    const row = await this.tx.approvalPolicy.create({
      data: { ...this.scope, ...input },
      select: { id: true },
    });
    return row.id;
  }

  async updatePolicy(id: string, patch: { requiredApprovals?: number; active?: boolean }) {
    await this.tx.approvalPolicy.updateMany({ where: { ...this.scope, id }, data: patch });
  }

  async requests(filter: { pending: boolean }) {
    const rows = await this.tx.approvalRequest.findMany({
      where: { ...this.scope, ...(filter.pending ? { status: 'PENDING' } : {}) },
      select: REQUEST,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return (rows as RequestRow[]).map(toRequest);
  }

  async request(id: string) {
    const row = await this.tx.approvalRequest.findFirst({
      where: { ...this.scope, id },
      select: REQUEST,
    });
    return row ? toRequest(row as RequestRow) : null;
  }

  async createRequest(input: Parameters<ApprovalUnitOfWork['createRequest']>[0]) {
    const row = await this.tx.approvalRequest.create({
      data: { ...this.scope, ...input, requestedByUserId: this.userId },
      select: { id: true },
    });
    return row.id;
  }

  async withdraw(id: string) {
    await this.tx.approvalRequest.updateMany({
      where: { ...this.scope, id, status: 'PENDING' },
      data: { status: 'WITHDRAWN' },
    });
  }

  async decide(id: string, decision: 'APPROVE' | 'REJECT', note: string | null) {
    // The database settles the request (app_approval_settle).
    await this.tx.approvalDecision.create({
      data: { ...this.scope, requestId: id, userId: this.userId, decision, note },
    });
  }

  async committeeMembers(committeeId: string, today: string) {
    const day = new Date(`${today}T00:00:00Z`);
    const rows = await this.tx.committeeMember.findMany({
      where: {
        ...this.scope,
        committeeId,
        committee: { status: 'ACTIVE' },
        termStart: { lte: day },
        OR: [{ termEnd: null }, { termEnd: { gte: day } }],
      },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  async audit(event: Parameters<ApprovalUnitOfWork['audit']>[0]) {
    await this.tx.auditLog.createMany({
      data: [
        {
          organisationId: this.organisationId,
          actorUserId: this.userId,
          action: event.action,
          resourceType: event.action.startsWith('approval_policy')
            ? 'approval_policy'
            : 'approval_request',
          resourceId: event.resourceId,
          metadata: { propertyId: this.propertyId, ...(event.metadata ?? {}) },
          requestId: clip(this.meta.requestId, 128),
          ipAddress: clip(this.meta.ipAddress, 64),
        },
      ],
    });
  }
}

/** Approval persistence over Prisma, always inside the organisation's RLS context. */
@Injectable()
export class PrismaApprovalRepository implements ApprovalRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: ApprovalUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaApprovalUnitOfWork(tx, organisationId, propertyId, userId, meta)),
      { userId },
    );
  }
}

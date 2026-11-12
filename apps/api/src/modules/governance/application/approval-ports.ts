import type { RequestMeta } from '../../../platform/request-meta';
import type { TransactionHandle } from '../../../platform/transaction-handle';
import type {
  ApprovalRequestType,
  ApprovalStatus,
  ApproverGroup,
  PolicyRule,
} from '../domain/approval-rules';

export interface PolicyRecord extends PolicyRule {
  committeeName: string | null;
  createdAt: Date;
}

export interface DecisionRecord {
  userId: string;
  name: string;
  decision: 'APPROVE' | 'REJECT';
  note: string | null;
  createdAt: Date;
}

export interface ApprovalRequestRecord {
  id: string;
  number: number;
  requestType: ApprovalRequestType;
  title: string;
  description: string;
  amountMinor: bigint | null;
  currency: string | null;
  document: { id: string; title: string } | null;
  requiredApprovals: number;
  approvers: ApproverGroup;
  committee: { id: string; name: string } | null;
  status: ApprovalStatus;
  requestedByUserId: string;
  requestedByName: string;
  decidedAt: Date | null;
  createdAt: Date;
  decisions: DecisionRecord[];
}

/** One transaction in the organisation's RLS context, limited to one property. */
export interface ApprovalUnitOfWork {
  transaction(): TransactionHandle;
  currency(): Promise<string>;
  today(): Promise<string>;
  policies(): Promise<PolicyRecord[]>;
  policy(id: string): Promise<PolicyRecord | null>;
  createPolicy(input: Omit<PolicyRule, 'id' | 'active'>): Promise<string>;
  updatePolicy(id: string, patch: { requiredApprovals?: number; active?: boolean }): Promise<void>;
  requests(filter: { pending: boolean }): Promise<ApprovalRequestRecord[]>;
  request(id: string): Promise<ApprovalRequestRecord | null>;
  createRequest(input: {
    requestType: ApprovalRequestType;
    title: string;
    description: string;
    amountMinor: bigint | null;
    currency: string | null;
    documentId: string | null;
    policyId: string | null;
    requiredApprovals: number;
    approvers: ApproverGroup;
    committeeId: string | null;
  }): Promise<string>;
  withdraw(id: string): Promise<void>;
  decide(id: string, decision: 'APPROVE' | 'REJECT', note: string | null): Promise<void>;
  /** People holding a seat on the committee on `today`. */
  committeeMembers(committeeId: string, today: string): Promise<string[]>;
  audit(event: {
    action: string;
    resourceId: string;
    metadata?: Record<string, string | number | boolean>;
  }): Promise<void>;
}

export interface ApprovalRepository {
  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: ApprovalUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export const APPROVAL_REPOSITORY = Symbol('APPROVAL_REPOSITORY');

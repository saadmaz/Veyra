import { z } from 'zod';

/*
 * Approvals (PRD 3.11, DATA_MODEL section 11). The database enforces the request and decision
 * rules again (migration 20261128090000_approvals).
 */

export const APPROVAL_REQUEST_TYPES = ['EXPENSE', 'PURCHASE', 'POLICY', 'ACCESS', 'OTHER'] as const;
export type ApprovalRequestType = (typeof APPROVAL_REQUEST_TYPES)[number];
export type ApproverGroup = 'MANAGERS' | 'COMMITTEE';
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';

export interface PolicyRule {
  id: string;
  requestType: ApprovalRequestType;
  minAmountMinor: bigint;
  requiredApprovals: number;
  approvers: ApproverGroup;
  committeeId: string | null;
  active: boolean;
}

/** What a request needs when there is no policy for it: one manager. */
export const DEFAULT_RULE = {
  requiredApprovals: 1,
  approvers: 'MANAGERS' as const,
  committeeId: null,
};

/**
 * The policy for a request: the active one of its type with the highest threshold at or below the
 * amount (a request without an amount counts as zero). None: the default rule.
 */
export function policyFor<T extends PolicyRule>(
  policies: T[],
  type: ApprovalRequestType,
  amountMinor: bigint | null,
): T | null {
  const amount = amountMinor ?? 0n;
  let best: T | null = null;
  for (const p of policies) {
    if (!p.active || p.requestType !== type || p.minAmountMinor > amount) continue;
    if (!best || p.minAmountMinor > best.minAmountMinor) best = p;
  }
  return best;
}

const text = (max: number) => z.string().trim().min(1).max(max);

/** A positive decimal such as "1500.50", checked against the currency's decimals later. */
const amount = z
  .string()
  .trim()
  .regex(/^\d{1,13}(\.\d{1,4})?$/, 'Use a positive amount such as 1500.50');

export const policySchema = z
  .object({
    requestType: z.enum(APPROVAL_REQUEST_TYPES),
    minAmount: amount.default('0'),
    requiredApprovals: z.int().min(1).max(10),
    approvers: z.enum(['MANAGERS', 'COMMITTEE']),
    committeeId: z.uuid().nullable().optional(),
  })
  .refine((v) => (v.approvers === 'COMMITTEE') === Boolean(v.committeeId), {
    message: 'Choose a committee exactly when committee members approve',
    path: ['committeeId'],
  });
export type PolicyInput = z.infer<typeof policySchema>;

export const updatePolicySchema = z
  .object({ requiredApprovals: z.int().min(1).max(10), active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Change at least one thing');
export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;

export const approvalRequestSchema = z.object({
  requestType: z.enum(APPROVAL_REQUEST_TYPES),
  title: text(160),
  description: text(4000),
  amount: amount.nullable().optional(),
  documentId: z.uuid().nullable().optional(),
});
export type ApprovalRequestInput = z.infer<typeof approvalRequestSchema>;

export const decisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z
      .string()
      .trim()
      .max(1000)
      .nullable()
      .optional()
      .transform((v) => (v ? v : null)),
  })
  .refine((v) => v.decision === 'APPROVE' || Boolean(v.note), {
    message: 'Say why you reject it',
    path: ['note'],
  });
export type DecisionInput = z.infer<typeof decisionSchema>;

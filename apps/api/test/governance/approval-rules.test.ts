import { describe, expect, it } from 'vitest';
import {
  approvalRequestSchema,
  decisionSchema,
  type PolicyRule,
  policyFor,
  policySchema,
} from '../../src/modules/governance/domain/approval-rules';

const rule = (over: Partial<PolicyRule>): PolicyRule => ({
  id: 'p',
  requestType: 'EXPENSE',
  minAmountMinor: 0n,
  requiredApprovals: 1,
  approvers: 'MANAGERS',
  committeeId: null,
  active: true,
  ...over,
});

describe('approval rules', () => {
  it('pick the active policy with the highest threshold at or below the amount', () => {
    const all = [
      rule({ id: 'base' }),
      rule({ id: 'big', minAmountMinor: 10_000_000n, approvers: 'COMMITTEE', committeeId: 'c' }),
      rule({ id: 'retired', minAmountMinor: 5_000_000n, active: false }),
      rule({ id: 'purchase', requestType: 'PURCHASE', minAmountMinor: 1n }),
    ];
    expect(policyFor(all, 'EXPENSE', 50_000n)?.id).toBe('base');
    expect(policyFor(all, 'EXPENSE', 10_000_000n)?.id).toBe('big');
    expect(policyFor(all, 'EXPENSE', 7_000_000n)?.id).toBe('base');
    expect(policyFor(all, 'EXPENSE', null)?.id).toBe('base');
    expect(policyFor(all, 'PURCHASE', null)).toBeNull();
    expect(policyFor(all, 'POLICY', 1n)).toBeNull();
  });

  it('name a committee exactly when committee members approve', () => {
    const base = { requestType: 'EXPENSE', requiredApprovals: 2 };
    expect(policySchema.safeParse({ ...base, approvers: 'COMMITTEE' }).success).toBe(false);
    expect(
      policySchema.safeParse({
        ...base,
        approvers: 'MANAGERS',
        committeeId: '0190a0a0-0000-7000-8000-000000000000',
      }).success,
    ).toBe(false);
    expect(policySchema.safeParse({ ...base, approvers: 'MANAGERS' }).success).toBe(true);
  });

  it('need a reason to reject, and a positive decimal amount', () => {
    expect(decisionSchema.safeParse({ decision: 'REJECT' }).success).toBe(false);
    expect(decisionSchema.safeParse({ decision: 'REJECT', note: 'Too costly' }).success).toBe(true);
    expect(decisionSchema.safeParse({ decision: 'APPROVE' }).success).toBe(true);
    const r = { requestType: 'EXPENSE', title: 'Pump', description: 'Broken' };
    expect(approvalRequestSchema.safeParse({ ...r, amount: '-5' }).success).toBe(false);
    expect(approvalRequestSchema.safeParse({ ...r, amount: '1500.50' }).success).toBe(true);
  });
});

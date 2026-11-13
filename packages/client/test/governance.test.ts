import type { ApprovalRequestDto } from '@veyra/api-contracts';
import { describe, expect, it } from 'vitest';
import { approvalProgress, incidentMoves } from '../src/governance';

describe('governance helpers', () => {
  it('offer the next incident moves, closing only with every follow-up done', () => {
    expect(incidentMoves('OPEN', 0).map((m) => m.to)).toEqual(['RESPONDING', 'RESOLVED']);
    expect(incidentMoves('RESPONDING', 0).map((m) => m.to)).toEqual(['RESOLVED']);
    expect(incidentMoves('RESOLVED', 0).map((m) => m.to)).toEqual(['CLOSED', 'RESPONDING']);
    expect(incidentMoves('RESOLVED', 2).map((m) => m.to)).toEqual(['RESPONDING']);
    expect(incidentMoves('CLOSED', 0)).toEqual([]);
  });

  it('describe how far a request has got', () => {
    const r = {
      status: 'PENDING',
      approvals: 1,
      requiredApprovals: 2,
      approvers: 'COMMITTEE',
      committee: { id: 'c', name: 'Board' },
    } as ApprovalRequestDto;
    expect(approvalProgress(r)).toBe('1 of 2 approvals from Board');
    expect(
      approvalProgress({ ...r, status: 'APPROVED', approvals: 2, approvers: 'MANAGERS' }),
    ).toBe('approved (2 of 2 approvals from managers)');
  });
});

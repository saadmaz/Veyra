import type {
  ApprovalRequestDto,
  ApprovalRequestType,
  CommitteePosition,
  IncidentCategory,
  IncidentSeverity,
  IncidentStatus,
} from '@veyra/api-contracts';

export const INCIDENT_CATEGORY_LABELS: Record<IncidentCategory, string> = {
  SECURITY: 'Security',
  FIRE: 'Fire',
  MEDICAL: 'Medical',
  FLOOD: 'Flood or leak',
  POWER: 'Power',
  LIFT: 'Lift',
  GAS: 'Gas',
  NOISE: 'Noise',
  DAMAGE: 'Damage',
  OTHER: 'Other',
};

export const SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

export const SEVERITY_TONES: Record<IncidentSeverity, 'muted' | 'warning' | 'danger'> = {
  LOW: 'muted',
  MEDIUM: 'warning',
  HIGH: 'danger',
  CRITICAL: 'danger',
};

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  OPEN: 'Open',
  RESPONDING: 'Responding',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

/** The status moves a manager can make next, with button labels. */
export function incidentMoves(
  status: IncidentStatus,
  openActions: number,
): { to: 'RESPONDING' | 'RESOLVED' | 'CLOSED'; label: string }[] {
  if (status === 'OPEN') {
    return [
      { to: 'RESPONDING', label: 'Start responding' },
      { to: 'RESOLVED', label: 'Resolve' },
    ];
  }
  if (status === 'RESPONDING') return [{ to: 'RESOLVED', label: 'Resolve' }];
  if (status === 'RESOLVED') {
    const reopen = { to: 'RESPONDING' as const, label: 'Reopen' };
    return openActions === 0 ? [{ to: 'CLOSED', label: 'Close' }, reopen] : [reopen];
  }
  return [];
}

export const POSITION_LABELS: Record<CommitteePosition, string> = {
  CHAIR: 'Chair',
  VICE_CHAIR: 'Vice-chair',
  SECRETARY: 'Secretary',
  TREASURER: 'Treasurer',
  MEMBER: 'Member',
};

export const REQUEST_TYPE_LABELS: Record<ApprovalRequestType, string> = {
  EXPENSE: 'Expense',
  PURCHASE: 'Purchase',
  POLICY: 'Policy change',
  ACCESS: 'Access',
  OTHER: 'Other',
};

/** Who approves a request, and how far it has got. */
export function approvalProgress(r: ApprovalRequestDto): string {
  const who = r.approvers === 'COMMITTEE' ? (r.committee?.name ?? 'the committee') : 'managers';
  if (r.status === 'PENDING')
    return `${r.approvals} of ${r.requiredApprovals} approvals from ${who}`;
  return `${r.status.toLowerCase()} (${r.approvals} of ${r.requiredApprovals} approvals from ${who})`;
}

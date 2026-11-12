'use client';

import type { ChecklistStatus, ShiftStatus } from '@veyra/api-contracts';
import { Badge } from '@/components/ui';

const SHIFT: Record<ShiftStatus, [string, 'success' | 'warning' | 'muted' | 'danger']> = {
  SCHEDULED: ['planned', 'muted'],
  STARTED: ['on shift', 'success'],
  ENDED: ['ended', 'muted'],
  CANCELLED: ['cancelled', 'danger'],
};

const CHECKLIST: Record<ChecklistStatus, [string, 'success' | 'warning' | 'muted' | 'danger']> = {
  OPEN: ['to do', 'warning'],
  SUBMITTED: ['handed in', 'muted'],
  VERIFIED: ['checked', 'success'],
  CANCELLED: ['cancelled', 'danger'],
};

export function ShiftBadge({ status }: { status: ShiftStatus }) {
  const [label, tone] = SHIFT[status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function ChecklistBadge({ status }: { status: ChecklistStatus }) {
  const [label, tone] = CHECKLIST[status];
  return <Badge tone={tone}>{label}</Badge>;
}

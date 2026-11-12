'use client';

import type { VendorCompliance, VendorDto } from '@veyra/api-contracts';
import { Badge } from '@/components/ui';

export const COMPLIANCE_LABELS: Record<VendorCompliance, string> = {
  OK: 'papers in order',
  EXPIRING_SOON: 'papers expiring soon',
  EXPIRED: 'papers expired',
  NO_DOCUMENTS: 'no papers on file',
};

const TONES: Record<VendorCompliance, 'success' | 'warning' | 'danger' | 'muted'> = {
  OK: 'success',
  EXPIRING_SOON: 'warning',
  EXPIRED: 'danger',
  NO_DOCUMENTS: 'muted',
};

/** The vendor's status when it is not active, otherwise how its papers stand. */
export function ComplianceBadge({ vendor }: { vendor: Pick<VendorDto, 'status' | 'compliance'> }) {
  if (vendor.status === 'SUSPENDED') return <Badge tone="danger">suspended</Badge>;
  if (vendor.status === 'ARCHIVED') return <Badge>archived</Badge>;
  return <Badge tone={TONES[vendor.compliance]}>{COMPLIANCE_LABELS[vendor.compliance]}</Badge>;
}

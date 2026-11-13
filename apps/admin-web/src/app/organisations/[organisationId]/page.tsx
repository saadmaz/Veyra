'use client';

import { useParams } from 'next/navigation';
import { OrganisationDetail } from '@/components/organisation-detail';
import { StaffGate } from '@/components/staff-gate';

/** One organisation: plan, usage, suspension and support access. */
export default function OrganisationPage() {
  const { organisationId } = useParams<{ organisationId: string }>();
  return (
    <StaffGate>
      <OrganisationDetail id={organisationId} />
    </StaffGate>
  );
}

'use client';

import type { ApprovalRequestDto } from '@veyra/api-contracts';
import { useParams } from 'next/navigation';
import { ApprovalItem } from '@/components/approvals';
import { type PropertyContext, PropertyFrame } from '@/components/property-frame';
import { Card, EmptyState, ErrorState, LoadingState } from '@/components/ui';
import { ApiRequestError } from '@/lib/api-client';
import { useApiQuery } from '@/lib/use-api';

/** One approval request (where approval notifications link to). */
export default function ApprovalRequestPage() {
  return (
    <PropertyFrame
      title="Approval request"
      permission="property.approval.read"
      crumb={{ label: 'Approvals', path: '/approvals' }}
      denied={{
        title: 'You cannot see approvals here',
        text: 'Approvals are for managers, finance and maintenance staff, and committee members.',
      }}
    >
      {(ctx) => <Request ctx={ctx} />}
    </PropertyFrame>
  );
}

function Request({ ctx }: { ctx: PropertyContext }) {
  const { requestId } = useParams<{ requestId: string }>();
  const path = `${ctx.propertyPath}/approval-requests/${requestId}`;
  const request = useApiQuery<ApprovalRequestDto>(path);
  if (request.status === 'loading') return <LoadingState label="Loading request" />;
  if (request.status === 'error') {
    if (request.error instanceof ApiRequestError && request.error.status === 404) {
      return <EmptyState title="Request not found">It does not exist.</EmptyState>;
    }
    return <ErrorState error={request.error} onRetry={request.reload} />;
  }
  return (
    <Card title={request.data.reference}>
      <ApprovalItem
        request={request.data}
        path={path}
        currentUserId={ctx.currentUserId}
        onDone={request.reload}
      />
    </Card>
  );
}

'use client';

import type { FinanceApprovalDto, FinanceApprovalStatus } from '@veyra/api-contracts';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { type FinanceContext, FinanceFrame } from '@/components/finance-frame';
import {
  Alert,
  Badge,
  Button,
  Card,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api-client';
import { APPROVAL_ACTION_LABELS, formatMoney, PAYMENT_METHOD_LABELS } from '@/lib/finance';
import { errorMessage } from '@/lib/messages';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';
import { formatInstant } from '@/lib/visitors';

export default function ApprovalsPage() {
  return (
    <FinanceFrame section="approvals" title="Approvals">
      {(ctx) => <Approvals ctx={ctx} />}
    </FinanceFrame>
  );
}

const STATUS_TONES: Record<FinanceApprovalStatus, 'warning' | 'success' | 'danger' | 'muted'> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'muted',
};

/**
 * Maker-checker: reversals, refunds, write-offs and reopening a period wait here until a second
 * person decides. The API refuses a decision by the requester (SAME_PERSON); the screen only
 * hides the buttons.
 */
function Approvals({ ctx }: { ctx: FinanceContext }) {
  const [status, setStatus] = useState<FinanceApprovalStatus>('PENDING');
  const approvals = useApiQuery<{ data: FinanceApprovalDto[] }>(
    `${ctx.financePath}/approvals?status=${status}`,
  );
  const rows = approvals.status === 'success' ? approvals.data.data : [];
  return (
    <Card title="Requests">
      <div className="form form--inline">
        <SelectField
          label="Show"
          value={status}
          onChange={(event) => setStatus(event.target.value as FinanceApprovalStatus)}
        >
          <option value="PENDING">Waiting</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
          <option value="CANCELLED">Cancelled</option>
        </SelectField>
      </div>
      {approvals.status === 'loading' ? <LoadingState label="Loading requests" /> : null}
      {approvals.status === 'error' ? (
        <ErrorState error={approvals.error} onRetry={approvals.reload} />
      ) : null}
      {approvals.status === 'success' && rows.length === 0 ? (
        <p className="muted">No requests here.</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Approval requests">
          {rows.map((a) => (
            <Request key={a.id} ctx={ctx} approval={a} onChanged={approvals.reload} />
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function target(ctx: FinanceContext, a: FinanceApprovalDto) {
  if (a.paymentId)
    return <Link href={`${ctx.financePath}/payments/${a.paymentId}`}>the payment</Link>;
  if (a.invoiceId)
    return <Link href={`${ctx.financePath}/invoices/${a.invoiceId}`}>the invoice</Link>;
  return <Link href={`${ctx.financePath}/reports`}>the period</Link>;
}

function Request({
  ctx,
  approval: a,
  onChanged,
}: {
  ctx: FinanceContext;
  approval: FinanceApprovalDto;
  onChanged(): void;
}) {
  const decide = useAction();
  const [deciding, setDeciding] = useState(false);
  const mine = a.requestedBy.userId === ctx.currentUserId;
  const timeZone = ctx.property.timeZone;
  const title = `${APPROVAL_ACTION_LABELS[a.action]}${a.amount ? ` of ${formatMoney(a.amount)}` : ''}`;
  const send = (verb: 'approve' | 'reject' | 'cancel', note?: string) =>
    void decide
      .run(() =>
        api.post(
          `${ctx.financePath}/approvals/${a.id}/${verb}`,
          verb === 'cancel' ? undefined : note ? { note } : {},
        ),
      )
      .then((ok) => {
        if (!ok) return;
        setDeciding(false);
        onChanged();
      });
  return (
    <li className="list__item">
      <div>
        <p className="list__primary">
          {title} <Badge tone={STATUS_TONES[a.status]}>{a.status.toLowerCase()}</Badge>
        </p>
        <p className="list__meta">
          For {target(ctx, a)}
          {a.refundMethod ? ` · paid back by ${PAYMENT_METHOD_LABELS[a.refundMethod]}` : ''} · asked
          by {mine ? 'you' : a.requestedBy.name} on {formatInstant(a.createdAt, timeZone)}
        </p>
        <p className="list__meta">Reason: {a.reason}</p>
        {a.decidedBy && a.decidedAt ? (
          <p className="list__meta">
            {a.status === 'CANCELLED' ? 'Cancelled' : 'Decided'} by {a.decidedBy.name} on{' '}
            {formatInstant(a.decidedAt, timeZone)}
            {a.decisionNote ? `: ${a.decisionNote}` : ''}
          </p>
        ) : null}
        {a.status === 'PENDING' && mine ? (
          <p className="list__meta">Someone else must approve this.</p>
        ) : null}
      </div>
      {decide.error ? <Alert>{errorMessage(decide.error)}</Alert> : null}
      {a.status === 'PENDING' && mine && ctx.can('property.finance.manage') ? (
        <Button
          variant="secondary"
          busy={decide.busy}
          aria-label={`Cancel request: ${title}`}
          onClick={() => {
            if (window.confirm('Cancel this request?')) send('cancel');
          }}
        >
          Cancel request
        </Button>
      ) : null}
      {a.status === 'PENDING' && !mine && ctx.can('property.finance.approve') && !deciding ? (
        <Button
          variant="secondary"
          aria-label={`Decide: ${title}`}
          onClick={() => setDeciding(true)}
        >
          Decide
        </Button>
      ) : null}
      {deciding ? (
        <form
          className="form form--inline"
          noValidate
          aria-label={`Decide: ${title}`}
          onSubmit={(event: FormEvent<HTMLFormElement>) => event.preventDefault()}
        >
          <TextField label="Note (optional)" name="note" maxLength={500} id={`note-${a.id}`} />
          <Button
            busy={decide.busy}
            onClick={(event) => {
              const form = event.currentTarget.form;
              const note = form ? String(new FormData(form).get('note') ?? '').trim() : '';
              send('approve', note);
            }}
          >
            Approve
          </Button>
          <Button
            variant="danger"
            busy={decide.busy}
            onClick={(event) => {
              const form = event.currentTarget.form;
              const note = form ? String(new FormData(form).get('note') ?? '').trim() : '';
              send('reject', note);
            }}
          >
            Reject
          </Button>
        </form>
      ) : null}
    </li>
  );
}

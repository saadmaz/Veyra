'use client';

import type { BankTransferDto, BankTransferStatus } from '@veyra/api-contracts';
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
import {
  formatMoney,
  PARTY_LABELS,
  TRANSFER_STATUS_LABELS,
  TRANSFER_STATUS_TONES,
} from '@/lib/finance';
import { errorMessage } from '@/lib/messages';
import { formatDate, todayIn } from '@/lib/residents';
import { useAction } from '@/lib/use-action';
import { useApiQuery } from '@/lib/use-api';
import { formatInstant } from '@/lib/visitors';

export default function TransfersPage() {
  return (
    <FinanceFrame section="transfers" title="Bank transfers">
      {(ctx) => <Transfers ctx={ctx} />}
    </FinanceFrame>
  );
}

/**
 * Bank transfers residents reported (Phase 6 Part 6). Finance checks each one against the bank
 * account: confirming records a bank-transfer payment for that account (applied to its unpaid
 * invoices, oldest first); rejecting sends the reason to the resident. The API refuses a
 * decision by the person who reported the transfer (SAME_PERSON).
 */
function Transfers({ ctx }: { ctx: FinanceContext }) {
  const [status, setStatus] = useState<BankTransferStatus>('PENDING');
  const transfers = useApiQuery<{ data: BankTransferDto[] }>(
    `${ctx.financePath}/bank-transfers?status=${status}`,
  );
  const rows = transfers.status === 'success' ? transfers.data.data : [];
  return (
    <Card title="Reported by residents">
      <p className="muted">
        Check each transfer against the bank statement before confirming it. Confirming records the
        payment and issues the receipt.
      </p>
      <div className="form form--inline">
        <SelectField
          label="Show"
          value={status}
          onChange={(event) => setStatus(event.target.value as BankTransferStatus)}
        >
          <option value="PENDING">Waiting</option>
          <option value="CONFIRMED">Confirmed</option>
          <option value="REJECTED">Not confirmed</option>
        </SelectField>
      </div>
      {transfers.status === 'loading' ? <LoadingState label="Loading transfers" /> : null}
      {transfers.status === 'error' ? (
        <ErrorState error={transfers.error} onRetry={transfers.reload} />
      ) : null}
      {transfers.status === 'success' && rows.length === 0 ? (
        <p className="muted">No transfers here.</p>
      ) : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Bank transfers">
          {rows.map((t) => (
            <Transfer key={t.id} ctx={ctx} transfer={t} onChanged={transfers.reload} />
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function Transfer({
  ctx,
  transfer: t,
  onChanged,
}: {
  ctx: FinanceContext;
  transfer: BankTransferDto;
  onChanged(): void;
}) {
  const decide = useAction();
  const [mode, setMode] = useState<'confirm' | 'reject' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const timeZone = ctx.property.timeZone;
  const today = todayIn(timeZone);
  const title = `${formatMoney(t.amount)} for unit ${t.unitNumber}`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => String(form.get(key) ?? '').trim();
    if (mode === 'reject' && !text('reason')) {
      setProblem('Tell the resident why, for example what is missing.');
      return;
    }
    if (mode === 'confirm' && text('receivedOn') > today) {
      setProblem('This date is in the future.');
      return;
    }
    setProblem(null);
    const ok = await decide.run(() =>
      mode === 'confirm'
        ? api.post(`${ctx.financePath}/bank-transfers/${t.id}/confirm`, {
            ...(text('receivedOn') ? { receivedOn: text('receivedOn') } : {}),
          })
        : api.post(`${ctx.financePath}/bank-transfers/${t.id}/reject`, { reason: text('reason') }),
    );
    if (!ok) return;
    setMode(null);
    onChanged();
  }

  return (
    <li className="list__item">
      <div>
        <p className="list__primary">
          {title}{' '}
          <Badge tone={TRANSFER_STATUS_TONES[t.status]}>{TRANSFER_STATUS_LABELS[t.status]}</Badge>
        </p>
        <p className="list__meta">
          {PARTY_LABELS[t.paidBy]} · sent {formatDate(t.transferredOn)} · reference{' '}
          <strong>{t.reference}</strong> · reported by {t.submittedBy.name} on{' '}
          {formatInstant(t.createdAt, timeZone)}
        </p>
        {t.note ? <p className="list__meta">Note: {t.note}</p> : null}
        {t.status === 'CONFIRMED' && t.paymentId ? (
          <p className="list__meta">
            Recorded as{' '}
            <Link href={`${ctx.financePath}/payments/${t.paymentId}`}>{t.receiptNumber}</Link>
          </p>
        ) : null}
        {t.rejectionReason ? <p className="list__meta">Reason given: {t.rejectionReason}</p> : null}
      </div>
      {decide.error ? <Alert>{errorMessage(decide.error)}</Alert> : null}
      {t.status === 'PENDING' && ctx.can('property.finance.manage') && mode === null ? (
        <div className="form form--inline">
          <Button
            variant="secondary"
            aria-label={`Confirm: ${title}`}
            onClick={() => setMode('confirm')}
          >
            Confirm
          </Button>
          <Button
            variant="secondary"
            aria-label={`Reject: ${title}`}
            onClick={() => setMode('reject')}
          >
            Reject
          </Button>
        </div>
      ) : null}
      {mode ? (
        <form
          className="form form--inline"
          noValidate
          aria-label={`${mode === 'confirm' ? 'Confirm' : 'Reject'}: ${title}`}
          onSubmit={onSubmit}
        >
          {problem ? <Alert>{problem}</Alert> : null}
          {mode === 'confirm' ? (
            <TextField
              label="Received in the bank on"
              name="receivedOn"
              type="date"
              id={`received-${t.id}`}
              max={today}
              defaultValue={t.transferredOn}
            />
          ) : (
            <TextField
              label="Reason (shown to the resident)"
              name="reason"
              id={`reason-${t.id}`}
              maxLength={500}
              required
            />
          )}
          <Button
            type="submit"
            variant={mode === 'reject' ? 'danger' : 'primary'}
            busy={decide.busy}
          >
            {mode === 'confirm' ? 'Confirm and record payment' : 'Reject transfer'}
          </Button>
          <Button variant="secondary" onClick={() => setMode(null)}>
            Back
          </Button>
        </form>
      ) : null}
    </li>
  );
}

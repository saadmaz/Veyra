'use client';

import type { ApprovalRequestDto } from '@veyra/api-contracts';
import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { api } from '@/lib/api-client';
import { formatMoney } from '@/lib/finance';
import { approvalProgress, REQUEST_TYPE_LABELS } from '@/lib/governance';
import { errorMessage } from '@/lib/messages';
import { Alert, Badge, Button, TextField } from './ui';

const STATUS_TONES = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  WITHDRAWN: 'muted',
} as const;

/** An approval request with its decisions and, for its approvers, the decision buttons. */
export function ApprovalItem({
  request: r,
  path,
  link,
  currentUserId,
  onDone,
}: {
  request: ApprovalRequestDto;
  /** API path of the request. */
  path: string;
  /** Console path of its page, if it should link there. */
  link?: string;
  currentUserId: string;
  onDone: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const mine = r.requestedBy.userId === currentUserId && r.status === 'PENDING';

  async function post(sub: string, body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${path}${sub}`, body);
      setNote('');
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="inline-form" aria-label={`${r.reference} ${r.title}`}>
      <p className="list__primary">
        {link ? (
          <Link href={link}>{`${r.reference} ${r.title}`}</Link>
        ) : (
          `${r.reference} ${r.title}`
        )}{' '}
        <Badge tone={STATUS_TONES[r.status]}>{r.status.toLowerCase()}</Badge>{' '}
        <Badge>{REQUEST_TYPE_LABELS[r.requestType]}</Badge>
      </p>
      <p className="note">{r.description}</p>
      <p className="list__meta">
        {r.amount ? `${formatMoney(r.amount)} · ` : ''}asked by {r.requestedBy.name} ·{' '}
        {approvalProgress(r)}
        {r.document ? ` · see "${r.document.title}"` : ''}
      </p>
      {r.decisions.length > 0 ? (
        <ul className="list" aria-label="Decisions">
          {r.decisions.map((d) => (
            <li key={`${d.name}-${d.createdAt}`} className="list__meta">
              {d.name} {d.decision === 'APPROVE' ? 'approved' : 'rejected'}
              {d.note ? `: ${d.note}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      {r.canDecide ? (
        <form
          className="form"
          aria-label={`Decide ${r.reference}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            post('/decisions', { decision: 'APPROVE', note: note || null });
          }}
        >
          <TextField
            label="Note (needed to reject)"
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="form__actions">
            <Button type="submit" busy={busy}>
              Approve
            </Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={() => post('/decisions', { decision: 'REJECT', note: note || null })}
            >
              Reject
            </Button>
          </div>
        </form>
      ) : null}
      {mine ? (
        <div className="form__actions">
          <Button variant="secondary" busy={busy} onClick={() => post('/withdraw')}>
            Withdraw
          </Button>
        </div>
      ) : null}
    </article>
  );
}

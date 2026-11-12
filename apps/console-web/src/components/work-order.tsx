'use client';

import type { WorkOrderCostDto, WorkOrderDetailDto } from '@veyra/api-contracts';
import Link from 'next/link';
import { type FormEvent, type ReactNode, useState } from 'react';
import { api } from '@/lib/api-client';
import { formatMoney, parseAmount } from '@/lib/finance';
import { CATEGORY_LABELS, PRIORITY_LABELS, placeText } from '@/lib/maintenance';
import { errorMessage } from '@/lib/messages';
import { useAction } from '@/lib/use-action';
import { formatInstant } from '@/lib/visitors';
import { Attachments, NoteForm, Timeline, WorkBadge } from './maintenance';
import { Alert, Badge, Button, Card, SelectField, TableWrap, TextField } from './ui';

const COST_KINDS: Record<WorkOrderCostDto['kind'], string> = {
  LABOUR: 'Labour',
  MATERIAL: 'Materials',
  OTHER: 'Other',
};

/**
 * One work order: what to do and where, its costs (for reporting, never billed), files, messages
 * and history. `actions` holds what the viewer may do with it (assignment for managers, progress
 * for the assignee); `paths` says where this viewer's routes are.
 */
export function WorkOrderView({
  detail,
  timeZone,
  currency,
  paths,
  requestLink,
  canWrite,
  canVoidCosts,
  myUserId,
  actions,
  onChanged,
}: {
  detail: WorkOrderDetailDto;
  timeZone: string;
  currency: string;
  paths: { self: string; attachment: (id: string) => string };
  requestLink?: string;
  canWrite: boolean;
  canVoidCosts: boolean;
  myUserId: string;
  actions?: ReactNode;
  onChanged(): void;
}) {
  const w = detail.workOrder;
  const live = w.status !== 'COMPLETED' && w.status !== 'CANCELLED';
  return (
    <>
      <div className="page__header">
        <h1>
          {w.number}: {w.title}
        </h1>
        <WorkBadge status={w.status} />
      </div>
      <Card title="Work">
        <dl className="details">
          <div>
            <dt>Where</dt>
            <dd>{placeText(w)}</dd>
          </div>
          <div>
            <dt>Kind</dt>
            <dd>{CATEGORY_LABELS[w.category]}</dd>
          </div>
          <div>
            <dt>Priority</dt>
            <dd>{PRIORITY_LABELS[w.priority]}</dd>
          </div>
          <div>
            <dt>Assigned to</dt>
            <dd>{w.assignedTo ? w.assignedTo.name : 'Nobody yet'}</dd>
          </div>
          {w.requestNumber ? (
            <div>
              <dt>Request</dt>
              <dd>
                {requestLink ? <Link href={requestLink}>{w.requestNumber}</Link> : w.requestNumber}
              </dd>
            </div>
          ) : null}
          {w.dueAt ? (
            <div>
              <dt>Due</dt>
              <dd>{formatInstant(w.dueAt, timeZone)}</dd>
            </div>
          ) : null}
          {w.startedAt ? (
            <div>
              <dt>Started</dt>
              <dd>{formatInstant(w.startedAt, timeZone)}</dd>
            </div>
          ) : null}
          {w.completedAt ? (
            <div>
              <dt>Completed</dt>
              <dd>{formatInstant(w.completedAt, timeZone)}</dd>
            </div>
          ) : null}
        </dl>
        {w.description ? <p className="note">{w.description}</p> : null}
        {w.statusNote ? <p className="list__meta">Latest note: {w.statusNote}</p> : null}
        {actions}
      </Card>
      <Costs
        detail={detail}
        currency={currency}
        path={paths.self}
        canRecord={canWrite && w.status !== 'CANCELLED'}
        voidPath={
          canVoidCosts
            ? (id) => `${paths.self.replace(/\/work-orders\/[^/]+$/, '')}/costs/${id}/void`
            : null
        }
        timeZone={timeZone}
        onChanged={onChanged}
      />
      <Attachments
        items={detail.attachments}
        pathOf={(a) => paths.attachment(a.id)}
        canRemove={(a) => canWrite && (canVoidCosts || a.uploadedBy.userId === myUserId)}
        {...(canWrite && w.status !== 'CANCELLED'
          ? {
              upload: {
                base: `${paths.self}/attachments`,
                choose: { kind: true, visibility: w.requestId !== null },
              },
            }
          : {})}
        timeZone={timeZone}
        onChanged={onChanged}
      />
      {canWrite && live ? (
        <Card title="Add a message">
          <NoteForm
            path={`${paths.self}/notes`}
            chooseVisibility={w.requestId !== null}
            onAdded={onChanged}
          />
        </Card>
      ) : null}
      <Timeline events={detail.events} timeZone={timeZone} showVisibility />
    </>
  );
}

function Costs({
  detail,
  currency,
  path,
  canRecord,
  voidPath,
  timeZone,
  onChanged,
}: {
  detail: WorkOrderDetailDto;
  currency: string;
  path: string;
  canRecord: boolean;
  voidPath: ((id: string) => string) | null;
  timeZone: string;
  onChanged(): void;
}) {
  const record = useAction();
  const voiding = useAction();
  const [problems, setProblems] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (k: string) => String(data.get(k) ?? '').trim();
    const found: Record<string, string> = {};
    const amount = parseAmount(text('amount'), currency);
    if (!amount.ok) found.amount = amount.error;
    if (!text('description')) found.description = 'Say what it was for.';
    setProblems(found);
    if (Object.keys(found).length > 0 || !amount.ok) return;
    const ok = await record.run(() =>
      api.post(`${path}/costs`, {
        kind: text('kind'),
        description: text('description'),
        amount: amount.value,
      }),
    );
    if (ok) {
      form.reset();
      onChanged();
    }
  }

  const voidCost = (c: WorkOrderCostDto) => {
    if (!voidPath) return;
    const reason = window.prompt(`Why is ${c.description} wrong?`)?.trim();
    if (!reason) return;
    void voiding.run(() => api.post(voidPath(c.id), { reason })).then((ok) => ok && onChanged());
  };

  return (
    <Card title="Costs">
      <p className="muted">
        Recorded for reporting only; residents are never billed from here. Total{' '}
        <strong>{formatMoney(detail.totalCost)}</strong>.
      </p>
      {voiding.error ? <Alert>{errorMessage(voiding.error)}</Alert> : null}
      {detail.costs.length > 0 ? (
        <TableWrap label="Costs">
          <table className="table">
            <caption className="visually-hidden">Costs</caption>
            <thead>
              <tr>
                <th scope="col">What</th>
                <th scope="col">Kind</th>
                <th scope="col">By</th>
                <th scope="col" className="num">
                  Amount
                </th>
                {voidPath ? <th scope="col">Correction</th> : null}
              </tr>
            </thead>
            <tbody>
              {detail.costs.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.description}
                    {c.voidedAt ? (
                      <>
                        {' '}
                        <Badge tone="danger">voided</Badge>
                        <br />
                        <span className="muted">{c.voidReason}</span>
                      </>
                    ) : null}
                  </td>
                  <td>{COST_KINDS[c.kind]}</td>
                  <td>
                    {c.recordedBy.name}
                    <br />
                    <span className="muted">{formatInstant(c.createdAt, timeZone)}</span>
                  </td>
                  <td className="num">{formatMoney(c.amount)}</td>
                  {voidPath ? (
                    <td>
                      {!c.voidedAt ? (
                        <Button
                          variant="secondary"
                          aria-label={`Void ${c.description}`}
                          busy={voiding.busy}
                          onClick={() => voidCost(c)}
                        >
                          Void
                        </Button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ) : (
        <p className="muted">No costs recorded.</p>
      )}
      {canRecord ? (
        <form
          className="form form--inline"
          noValidate
          onSubmit={onSubmit}
          aria-label="Record a cost"
        >
          {record.error ? <Alert>{errorMessage(record.error)}</Alert> : null}
          <SelectField label="Kind" name="kind" defaultValue="MATERIAL">
            <option value="LABOUR">Labour</option>
            <option value="MATERIAL">Materials</option>
            <option value="OTHER">Other</option>
          </SelectField>
          <TextField label="What" name="description" maxLength={200} error={problems.description} />
          <TextField
            label={`Amount (${currency})`}
            name="amount"
            inputMode="decimal"
            error={problems.amount}
          />
          <Button type="submit" variant="secondary" busy={record.busy}>
            Record cost
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

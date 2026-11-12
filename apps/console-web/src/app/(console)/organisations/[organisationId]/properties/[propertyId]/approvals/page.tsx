'use client';

import type {
  ApprovalPolicyDto,
  ApprovalRequestDto,
  ApprovalRequestType,
  CommitteeDto,
} from '@veyra/api-contracts';
import { type FormEvent, useState } from 'react';
import { ApprovalItem } from '@/components/approvals';
import { type PropertyContext, PropertyFrame } from '@/components/property-frame';
import {
  Alert,
  Badge,
  Button,
  Card,
  CheckboxField,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api-client';
import { formatMoney, parseAmount } from '@/lib/finance';
import { REQUEST_TYPE_LABELS } from '@/lib/governance';
import { errorMessage, fieldErrors } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';

/** Approval requests, asking for one, and the policies that say who approves. */
export default function ApprovalsPage() {
  return (
    <PropertyFrame
      title="Approvals"
      permission="property.approval.read"
      denied={{
        title: 'You cannot see approvals here',
        text: 'Approvals are for managers, finance and maintenance staff, and committee members.',
      }}
    >
      {(ctx) => <Approvals ctx={ctx} />}
    </PropertyFrame>
  );
}

function Approvals({ ctx }: { ctx: PropertyContext }) {
  const [all, setAll] = useState(false);
  const base = `${ctx.propertyPath}/approval-requests`;
  const list = useApiQuery<{ data: ApprovalRequestDto[] }>(
    `${base}?status=${all ? 'all' : 'pending'}`,
  );
  const rows = list.status === 'success' ? list.data.data : [];
  return (
    <>
      <Card title={all ? 'All requests' : 'Waiting for a decision'}>
        <CheckboxField
          label="Show settled requests too"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />
        {list.status === 'loading' ? <LoadingState label="Loading requests" /> : null}
        {list.status === 'error' ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
        {list.status === 'success' && rows.length === 0 ? (
          <p className="muted">Nothing is waiting.</p>
        ) : null}
        {rows.length > 0 ? (
          <ul className="list" aria-label="Approval requests">
            {rows.map((r) => (
              <li key={r.id} className="list__item">
                <ApprovalItem
                  request={r}
                  path={`${base}/${r.id}`}
                  link={`${ctx.propertyPath}/approvals/${r.id}`}
                  currentUserId={ctx.currentUserId}
                  onDone={list.reload}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
      {ctx.can('property.approval.request') ? <Ask ctx={ctx} onDone={list.reload} /> : null}
      <Policies ctx={ctx} />
    </>
  );
}

function Ask({ ctx, onDone }: { ctx: PropertyContext; onDone: () => void }) {
  const currency = ctx.property.currency;
  const [form, setForm] = useState({
    requestType: 'EXPENSE' as ApprovalRequestType,
    title: '',
    description: '',
    amount: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<ApprovalRequestDto | null>(null);
  const fields = fieldErrors(error);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setDone(null);
    let amount: string | null = null;
    if (form.amount.trim()) {
      const parsed = parseAmount(form.amount, currency);
      if (!parsed.ok) {
        setProblem(parsed.error);
        return;
      }
      amount = parsed.value;
    }
    setProblem(null);
    setBusy(true);
    try {
      const created = await api.post<ApprovalRequestDto>(`${ctx.propertyPath}/approval-requests`, {
        requestType: form.requestType,
        title: form.title,
        description: form.description,
        amount,
      });
      setDone(created);
      setForm((f) => ({ ...f, title: '', description: '', amount: '' }));
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Ask for approval">
      <form onSubmit={submit} aria-label="Ask for approval" className="form">
        <div className="form__row">
          <SelectField
            label="Kind"
            value={form.requestType}
            onChange={(e) =>
              setForm((f) => ({ ...f, requestType: e.target.value as ApprovalRequestType }))
            }
          >
            {Object.entries(REQUEST_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SelectField>
          <TextField
            label="What for"
            value={form.title}
            maxLength={160}
            error={fields.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            required
          />
          <TextField
            label={`Amount in ${currency} (optional)`}
            inputMode="decimal"
            value={form.amount}
            error={problem ?? fields.amount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="approval-description">
            Why
          </label>
          <textarea
            id="approval-description"
            className="field__input"
            maxLength={4000}
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            required
          />
        </div>
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        {done ? (
          <Alert tone="success">
            Sent as {done.reference}: needs {done.requiredApprovals} approval
            {done.requiredApprovals === 1 ? '' : 's'} from{' '}
            {done.approvers === 'COMMITTEE' ? done.committee?.name : 'the managers'}.
          </Alert>
        ) : null}
        <div className="form__actions">
          <Button type="submit" busy={busy}>
            Send for approval
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Policies({ ctx }: { ctx: PropertyContext }) {
  const path = `${ctx.propertyPath}/approval-policies`;
  const policies = useApiQuery<{ data: ApprovalPolicyDto[] }>(path);
  const manage = ctx.can('property.governance.manage');
  const rows = policies.status === 'success' ? policies.data.data : [];
  const [error, setError] = useState<unknown>(null);

  async function retire(id: string) {
    setError(null);
    try {
      await api.patch(`${path}/${id}`, { active: false });
      policies.reload();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <Card title="Who approves what">
      <p className="muted">
        A request follows the active policy of its kind with the highest starting amount at or below
        its amount. Without one, a single manager approves.
      </p>
      {policies.status === 'loading' ? <LoadingState label="Loading policies" /> : null}
      {policies.status === 'error' ? (
        <ErrorState error={policies.error} onRetry={policies.reload} />
      ) : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Approval policies">
          {rows.map((p) => (
            <li key={p.id} className="list__item">
              <div>
                <p className="list__primary">
                  {REQUEST_TYPE_LABELS[p.requestType]} from {formatMoney(p.minAmount)}{' '}
                  {p.active ? null : <Badge>retired</Badge>}
                </p>
                <p className="list__meta">
                  {p.requiredApprovals} approval{p.requiredApprovals === 1 ? '' : 's'} from{' '}
                  {p.approvers === 'COMMITTEE' ? (p.committee?.name ?? 'a committee') : 'managers'}
                </p>
              </div>
              {manage && p.active ? (
                <Button variant="secondary" onClick={() => retire(p.id)}>
                  Retire
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      {manage ? <AddPolicy ctx={ctx} path={path} onDone={policies.reload} /> : null}
    </Card>
  );
}

function AddPolicy({
  ctx,
  path,
  onDone,
}: {
  ctx: PropertyContext;
  path: string;
  onDone: () => void;
}) {
  const committees = useApiQuery<{ data: CommitteeDto[] }>(`${ctx.propertyPath}/committees`);
  const active =
    committees.status === 'success'
      ? committees.data.data.filter((c) => c.status === 'ACTIVE')
      : [];
  const [form, setForm] = useState({
    requestType: 'EXPENSE' as ApprovalRequestType,
    minAmount: '0',
    requiredApprovals: '1',
    approvers: 'MANAGERS',
    committeeId: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const committeeId = form.committeeId || active[0]?.id || '';

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed =
      form.minAmount.trim() === '0'
        ? ({ ok: true, value: '0' } as const)
        : parseAmount(form.minAmount, ctx.property.currency);
    if (!parsed.ok) {
      setProblem(parsed.error);
      return;
    }
    setProblem(null);
    setBusy(true);
    setError(null);
    try {
      await api.post(path, {
        requestType: form.requestType,
        minAmount: parsed.value,
        requiredApprovals: Number(form.requiredApprovals),
        approvers: form.approvers,
        committeeId: form.approvers === 'COMMITTEE' ? committeeId : null,
      });
      onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Add a policy" className="form">
      <div className="form__row">
        <SelectField
          label="Kind"
          value={form.requestType}
          onChange={(e) =>
            setForm((f) => ({ ...f, requestType: e.target.value as ApprovalRequestType }))
          }
        >
          {Object.entries(REQUEST_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
        <TextField
          label={`From (${ctx.property.currency})`}
          inputMode="decimal"
          value={form.minAmount}
          error={problem ?? undefined}
          onChange={(e) => setForm((f) => ({ ...f, minAmount: e.target.value }))}
          required
        />
        <TextField
          label="Approvals needed"
          type="number"
          min={1}
          max={10}
          value={form.requiredApprovals}
          onChange={(e) => setForm((f) => ({ ...f, requiredApprovals: e.target.value }))}
          required
        />
        <SelectField
          label="Approved by"
          value={form.approvers}
          onChange={(e) => setForm((f) => ({ ...f, approvers: e.target.value }))}
        >
          <option value="MANAGERS">Managers</option>
          {active.length > 0 ? <option value="COMMITTEE">A committee</option> : null}
        </SelectField>
        {form.approvers === 'COMMITTEE' ? (
          <SelectField
            label="Committee"
            value={committeeId}
            onChange={(e) => setForm((f) => ({ ...f, committeeId: e.target.value }))}
          >
            {active.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectField>
        ) : null}
      </div>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <div className="form__actions">
        <Button type="submit" variant="secondary" busy={busy}>
          Add policy
        </Button>
      </div>
    </form>
  );
}

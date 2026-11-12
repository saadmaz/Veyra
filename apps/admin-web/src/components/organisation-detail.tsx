'use client';

import type {
  PlatformOrganisationDetailDto,
  PlatformPlanDto,
  SupportAccessDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api, errorText } from '@/lib/api';
import { planChangeProblem, planSummary, SUBSCRIPTION_STATUS_LABELS, when } from '@/lib/platform';

/** One organisation: plan, usage and history; change the plan, suspend, ask for support access. */
export function OrganisationDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<PlatformOrganisationDetailDto | null>(null);
  const [plans, setPlans] = useState<PlatformPlanDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([
        api.get<PlatformOrganisationDetailDto>(`/platform/organisations/${id}`),
        api.get<{ data: PlatformPlanDto[] }>('/platform/plans'),
      ]);
      setDetail(d);
      setPlans(p.data);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (missing) {
    return (
      <main className="page">
        <p>
          <Link href="/">Organisations</Link>
        </p>
        <h1>Organisation not found</h1>
      </main>
    );
  }
  if (!detail) {
    return (
      <main className="page">
        {error ? (
          <p role="alert" className="alert">
            {error}
          </p>
        ) : (
          <p className="muted" role="status">
            Loading organisation…
          </p>
        )}
      </main>
    );
  }
  const o = detail.organisation;
  return (
    <main className="page">
      <p>
        <Link href="/">Organisations</Link>
      </p>
      <h1>{o.name}</h1>
      <p className="muted">
        {o.slug} · {o.countryCode} · {o.status.toLowerCase()} · {planSummary(o)}
      </p>
      <dl className="figures">
        <div>
          <dt>Properties</dt>
          <dd>{detail.usage.properties}</dd>
        </div>
        <div>
          <dt>Units</dt>
          <dd>{detail.usage.units}</dd>
        </div>
        <div>
          <dt>Members</dt>
          <dd>{detail.usage.members}</dd>
        </div>
      </dl>
      <PlanForm id={id} detail={detail} plans={plans} onDone={setDetail} />
      <StatusForm id={id} status={o.status} onDone={setDetail} />
      <SupportForm id={id} />
      <h2>Subscription history</h2>
      <ul className="list" aria-label="Subscription history">
        {detail.history.map((h) => (
          <li key={h.createdAt + h.toPlan + h.toStatus}>
            {when(h.createdAt)} · {h.fromPlan ? `${h.fromPlan} → ` : ''}
            {h.toPlan} · {h.toStatus.toLowerCase()}
            {h.reason ? ` · ${h.reason}` : ''}
          </li>
        ))}
      </ul>
    </main>
  );
}

function PlanForm({
  id,
  detail,
  plans,
  onDone,
}: {
  id: string;
  detail: PlatformOrganisationDetailDto;
  plans: PlatformPlanDto[];
  onDone: (d: PlatformOrganisationDetailDto) => void;
}) {
  const s = detail.organisation.subscription;
  const [form, setForm] = useState({
    planCode: s?.planCode ?? 'ENTERPRISE',
    status: s?.status ?? 'ACTIVE',
    trialEndsOn: s?.trialEndsAt?.slice(0, 10) ?? '',
    reason: '',
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = planChangeProblem(form);
    if (problem) {
      setMessage({ ok: false, text: problem });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const updated = await api.post<PlatformOrganisationDetailDto>(
        `/platform/organisations/${id}/subscription`,
        {
          planCode: form.planCode,
          status: form.status,
          trialEndsAt: form.status === 'TRIAL' ? `${form.trialEndsOn}T23:59:59Z` : null,
          reason: form.reason,
        },
      );
      onDone(updated);
      setForm((f) => ({ ...f, reason: '' }));
      setMessage({ ok: true, text: 'Saved. The customer sees the change and the reason.' });
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form card" onSubmit={submit} aria-label="Change the plan">
      <h2>Plan</h2>
      <div className="row">
        <label className="field">
          <span>Plan</span>
          <select
            value={form.planCode}
            onChange={(e) => setForm((f) => ({ ...f, planCode: e.target.value }))}
          >
            {plans.map((p) => (
              <option key={p.code} value={p.code}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Status</span>
          <select
            value={form.status}
            onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as typeof f.status }))}
          >
            {Object.entries(SUBSCRIPTION_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {form.status === 'TRIAL' ? (
          <label className="field">
            <span>Trial ends on</span>
            <input
              type="date"
              value={form.trialEndsOn}
              onChange={(e) => setForm((f) => ({ ...f, trialEndsOn: e.target.value }))}
            />
          </label>
        ) : null}
      </div>
      <label className="field">
        <span>Reason (the customer sees it)</span>
        <input
          value={form.reason}
          maxLength={500}
          onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
        />
      </label>
      {message ? (
        <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'note' : 'alert'}>
          {message.text}
        </p>
      ) : null}
      <button type="submit" className="button" disabled={busy}>
        Save plan
      </button>
    </form>
  );
}

function StatusForm({
  id,
  status,
  onDone,
}: {
  id: string;
  status: string;
  onDone: (d: PlatformOrganisationDetailDto) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const suspended = status === 'SUSPENDED';
  if (status !== 'ACTIVE' && !suspended) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!reason.trim()) {
      setMessage('Give a reason: the customer sees it in their audit log.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      onDone(
        await api.post<PlatformOrganisationDetailDto>(
          `/platform/organisations/${id}/${suspended ? 'reactivate' : 'suspend'}`,
          { reason },
        ),
      );
      setReason('');
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form card" onSubmit={submit} aria-label={suspended ? 'Reactivate' : 'Suspend'}>
      <h2>{suspended ? 'Reactivate' : 'Suspend'}</h2>
      <p className="muted">
        {suspended
          ? 'The organisation is read-only. Reactivating lets its people make changes again.'
          : 'Suspending makes the organisation read-only for everyone in it.'}
      </p>
      <label className="field">
        <span>Reason</span>
        <input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </label>
      {message ? (
        <p role="alert" className="alert">
          {message}
        </p>
      ) : null}
      <button
        type="submit"
        className={suspended ? 'button' : 'button button--danger'}
        disabled={busy}
      >
        {suspended ? 'Reactivate' : 'Suspend'}
      </button>
    </form>
  );
}

function SupportForm({ id }: { id: string }) {
  const [form, setForm] = useState({ reason: '', hours: '2' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api.post<SupportAccessDto>(`/platform/organisations/${id}/support-access`, {
        reason: form.reason,
        hours: Number(form.hours),
      });
      setForm({ reason: '', hours: '2' });
      setMessage({
        ok: true,
        text: 'Asked. An organisation admin approves or denies it; you can then read, never change.',
      });
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form card" onSubmit={submit} aria-label="Ask for support access">
      <h2>Support access</h2>
      <p className="muted">You see none of this organisation's data unless its admins approve.</p>
      <div className="row">
        <label className="field">
          <span>Why</span>
          <input
            value={form.reason}
            maxLength={500}
            onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
            required
          />
        </label>
        <label className="field">
          <span>Hours (1 to 24)</span>
          <input
            type="number"
            min={1}
            max={24}
            value={form.hours}
            onChange={(e) => setForm((f) => ({ ...f, hours: e.target.value }))}
            required
          />
        </label>
      </div>
      {message ? (
        <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'note' : 'alert'}>
          {message.text}
        </p>
      ) : null}
      <button type="submit" className="button button--secondary" disabled={busy}>
        Ask for access
      </button>
    </form>
  );
}

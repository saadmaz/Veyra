'use client';

import type {
  OrganisationDetailResponse,
  SubscriptionDto,
  SupportAccessDto,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, LoadingState } from '@/components/ui';
import { ApiRequestError, api } from '@/lib/api-client';
import { errorMessage } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';

const FEATURE_LABELS: Record<string, string> = {
  visitors: 'Visitors and gate',
  finance: 'Finance and billing',
  maintenance: 'Maintenance',
  communications: 'Announcements and documents',
  facilities: 'Facilities and bookings',
  workforce: 'Staff and shifts',
  vendors: 'Vendors',
  incidents: 'Incidents',
  reporting: 'Exports',
  governance: 'Committees and approvals',
  integrations: 'Webhooks',
};

const STATUS_TEXT: Record<SubscriptionDto['status'], string> = {
  TRIAL: 'Trial',
  ACTIVE: 'Active',
  PAST_DUE: 'Payment overdue',
  CANCELLED: 'Cancelled',
};

const date = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(iso));
const dateTime = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );

/** The organisation's plan, usage, and support access asked for by VEYRA staff. */
export default function PlanPage() {
  const { organisationId } = useParams<{ organisationId: string }>();
  const base = `/organisations/${organisationId}`;
  const organisation = useApiQuery<OrganisationDetailResponse>(base);
  const allowed =
    organisation.status === 'success' &&
    organisation.data.permissions.includes('organisation.member.read');
  const subscription = useApiQuery<SubscriptionDto>(allowed ? `${base}/subscription` : null);

  useEffect(() => {
    document.title = 'Plan and support · VEYRA Console';
  }, []);

  if (organisation.status === 'loading') return <LoadingState label="Loading organisation" />;
  if (organisation.status === 'error') {
    if (organisation.error instanceof ApiRequestError && organisation.error.status === 404) {
      return (
        <EmptyState title="Organisation not found">
          It does not exist, or you do not have access to it.
        </EmptyState>
      );
    }
    return <ErrorState error={organisation.error} onRetry={organisation.reload} />;
  }
  const header = (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href={base}>{organisation.data.name}</Link>
      </nav>
      <div className="page__header">
        <h1>Plan and support</h1>
      </div>
    </>
  );
  if (!allowed) {
    return (
      <>
        {header}
        <EmptyState title="For organisation admins">
          Organisation admins see the plan and decide support access.
        </EmptyState>
      </>
    );
  }
  const canDecide = organisation.data.permissions.includes('organisation.member.manage');
  return (
    <>
      {header}
      {subscription.status === 'loading' ? <LoadingState label="Loading plan" /> : null}
      {subscription.status === 'error' ? (
        <ErrorState error={subscription.error} onRetry={subscription.reload} />
      ) : null}
      {subscription.status === 'success' ? <Plan s={subscription.data} /> : null}
      <Support base={base} canDecide={canDecide} />
    </>
  );
}

function Plan({ s }: { s: SubscriptionDto }) {
  const limit = (used: number, max: number | null) =>
    max === null ? `${used}` : `${used} of ${max}`;
  return (
    <>
      {s.lapsed ? (
        <Alert title="Your organisation is read-only">
          {s.status === 'CANCELLED' ? 'The subscription is cancelled.' : 'The trial has ended.'}{' '}
          Everyone can still look things up, but nothing can be changed until the plan is active
          again. Contact VEYRA to continue.
        </Alert>
      ) : null}
      <Card title={`${s.plan.name} plan`}>
        <dl className="details">
          <div>
            <dt>Status</dt>
            <dd>
              {STATUS_TEXT[s.status]}
              {s.status === 'TRIAL' && s.trialEndsAt ? ` until ${date(s.trialEndsAt)}` : ''}
            </dd>
          </div>
          <div>
            <dt>Properties</dt>
            <dd>{limit(s.usage.properties, s.plan.maxProperties)}</dd>
          </div>
          <div>
            <dt>Units</dt>
            <dd>{limit(s.usage.units, s.plan.maxUnits)}</dd>
          </div>
        </dl>
        <h3 className="section-title">Included</h3>
        <ul className="list" aria-label="Included features">
          {Object.entries(FEATURE_LABELS).map(([key, label]) => (
            <li key={key} className="list__meta">
              {label}{' '}
              {s.plan.features.includes(key) ? (
                <Badge tone="success">included</Badge>
              ) : (
                <Badge>not in this plan</Badge>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Changes">
        {s.history.length === 0 ? <p className="muted">No changes yet.</p> : null}
        <ul className="list" aria-label="Plan changes">
          {s.history.map((h) => (
            <li key={h.createdAt + h.toPlan + h.toStatus} className="list__meta">
              {dateTime(h.createdAt)} · {h.fromPlan ? `${h.fromPlan} → ` : ''}
              {h.toPlan} · {h.toStatus.toLowerCase()}
              {h.reason ? ` · ${h.reason}` : ''}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function Support({ base, canDecide }: { base: string; canDecide: boolean }) {
  const list = useApiQuery<{ data: SupportAccessDto[] }>(`${base}/support-access`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const rows = list.status === 'success' ? list.data.data : [];

  async function act(id: string, what: 'approve' | 'deny' | 'revoke') {
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/support-access/${id}/${what}`);
      list.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Support access">
      <p className="muted">
        VEYRA staff see none of your data unless you approve. Approved access is read-only, ends
        after the hours asked for, and you can end it at any time. Every step is recorded.
      </p>
      {list.status === 'loading' ? <LoadingState label="Loading support access" /> : null}
      {list.status === 'error' ? <ErrorState error={list.error} onRetry={list.reload} /> : null}
      {list.status === 'success' && rows.length === 0 ? (
        <p className="muted">No requests.</p>
      ) : null}
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      {rows.length > 0 ? (
        <ul className="list" aria-label="Support requests">
          {rows.map((r) => (
            <li key={r.id} className="list__item">
              <article className="inline-form" aria-label={`Request from ${r.requestedBy.name}`}>
                <p className="list__primary">
                  {r.requestedBy.name} ({r.requestedBy.email}) asks for {r.hours} hours{' '}
                  {r.active ? (
                    <Badge tone="warning">open</Badge>
                  ) : (
                    <Badge>{r.status.toLowerCase()}</Badge>
                  )}
                </p>
                <p className="note">{r.reason}</p>
                <p className="list__meta">
                  Asked {dateTime(r.createdAt)}
                  {r.decidedBy && r.decidedAt
                    ? ` · ${r.status === 'DENIED' ? 'denied' : 'approved'} by ${r.decidedBy} ${dateTime(r.decidedAt)}`
                    : ''}
                  {r.active && r.endsAt ? ` · open until ${dateTime(r.endsAt)}` : ''}
                </p>
                {canDecide ? (
                  <div className="form__actions">
                    {r.status === 'REQUESTED' ? (
                      <>
                        <Button busy={busy} onClick={() => act(r.id, 'approve')}>
                          Approve
                        </Button>
                        <Button variant="secondary" busy={busy} onClick={() => act(r.id, 'deny')}>
                          Deny
                        </Button>
                      </>
                    ) : null}
                    {r.active ? (
                      <Button variant="danger" busy={busy} onClick={() => act(r.id, 'revoke')}>
                        End access now
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </article>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

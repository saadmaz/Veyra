'use client';

import type {
  OrganisationDetailResponse,
  VendorDetailDto,
  VendorDocumentKind,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { BookingAction } from '@/components/facilities';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
} from '@/components/ui';
import { ComplianceBadge } from '@/components/vendors';
import { ApiRequestError, api } from '@/lib/api-client';
import { CATEGORY_LABELS } from '@/lib/maintenance';
import { errorMessage } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';

const KIND_LABELS: Record<VendorDocumentKind, string> = {
  INSURANCE: 'Insurance',
  LICENCE: 'Licence',
  CONTRACT: 'Contract',
  CERTIFICATE: 'Certificate',
  OTHER: 'Other',
};

/** One vendor: details, compliance documents, suspension and archiving. */
export default function VendorPage() {
  const { organisationId, vendorId } = useParams<{ organisationId: string; vendorId: string }>();
  const base = `/organisations/${organisationId}`;
  const path = `${base}/vendors/${vendorId}`;
  const organisation = useApiQuery<OrganisationDetailResponse>(base);
  const detail = useApiQuery<VendorDetailDto>(path);

  useEffect(() => {
    if (detail.status === 'success')
      document.title = `${detail.data.vendor.name} · Vendors · VEYRA Console`;
  }, [detail]);

  if (detail.status === 'loading' || organisation.status === 'loading') {
    return <LoadingState label="Loading vendor" />;
  }
  if (detail.status === 'error') {
    if (detail.error instanceof ApiRequestError && [403, 404].includes(detail.error.status)) {
      return (
        <EmptyState title="Vendor not found">
          It does not exist, or you do not have access to it.
        </EmptyState>
      );
    }
    return <ErrorState error={detail.error} onRetry={detail.reload} />;
  }
  if (organisation.status === 'error')
    return <ErrorState error={organisation.error} onRetry={organisation.reload} />;
  const { vendor: v, documents } = detail.data;
  const canManage =
    organisation.data.permissions.includes('organisation.vendor.manage') && v.status !== 'ARCHIVED';

  return (
    <>
      <nav aria-label="Breadcrumb" className="crumbs">
        <Link href={base}>{organisation.data.name}</Link>
        {' / '}
        <Link href={`${base}/vendors`}>Vendors</Link>
      </nav>
      <div className="page__header">
        <h1>
          {v.name} <ComplianceBadge vendor={v} />
        </h1>
      </div>

      <Card title="Details">
        <dl className="details">
          <div>
            <dt>Trades</dt>
            <dd>{v.categories.map((c) => CATEGORY_LABELS[c]).join(', ') || 'None listed'}</dd>
          </div>
          <div>
            <dt>Contact</dt>
            <dd>{[v.contactName, v.email, v.phone].filter(Boolean).join(' · ') || 'None'}</dd>
          </div>
          {v.taxReference ? (
            <div>
              <dt>Tax or company number</dt>
              <dd>{v.taxReference}</dd>
            </div>
          ) : null}
          {v.statusNote ? (
            <div>
              <dt>Suspended because</dt>
              <dd>{v.statusNote}</dd>
            </div>
          ) : null}
        </dl>
        {canManage ? (
          <div className="form__actions">
            {v.status === 'ACTIVE' ? (
              <BookingAction
                label="Suspend"
                path={`${path}/suspend`}
                reason="required"
                variant="danger"
                onDone={detail.reload}
              />
            ) : (
              <BookingAction
                label="Reactivate"
                path={`${path}/reactivate`}
                reason="none"
                onDone={detail.reload}
              />
            )}
            <BookingAction
              label="Archive vendor"
              path={`${path}/archive`}
              reason="none"
              variant="danger"
              onDone={detail.reload}
            />
          </div>
        ) : null}
      </Card>

      <Card title="Documents">
        {documents.length === 0 ? <p className="muted">No documents on file.</p> : null}
        {documents.length > 0 ? (
          <ul className="list" aria-label="Documents">
            {documents.map((d) => (
              <li key={d.id} className="list__item">
                <div>
                  <p className="list__primary">
                    {KIND_LABELS[d.kind]}: {d.title}{' '}
                    {d.voidedAt ? (
                      <Badge>voided</Badge>
                    ) : d.expired ? (
                      <Badge tone="danger">expired</Badge>
                    ) : null}
                  </p>
                  <p className="list__meta">
                    {d.reference ? `${d.reference} · ` : ''}
                    {d.expiresOn ? `valid until ${d.expiresOn}` : 'does not expire'} · added by{' '}
                    {d.addedBy}
                    {d.voidReason ? ` · voided: ${d.voidReason}` : ''}
                  </p>
                </div>
                {canManage && !d.voidedAt ? (
                  <BookingAction
                    label="Void"
                    path={`${path}/documents/${d.id}/void`}
                    reason="required"
                    onDone={detail.reload}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {canManage ? <AddDocument path={path} onAdded={detail.reload} /> : null}
      </Card>
    </>
  );
}

function AddDocument({ path, onAdded }: { path: string; onAdded: () => void }) {
  const [form, setForm] = useState({ kind: 'INSURANCE', title: '', reference: '', expiresOn: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`${path}/documents`, {
        kind: form.kind,
        title: form.title,
        reference: form.reference || null,
        expiresOn: form.expiresOn || null,
      });
      setForm({ kind: 'INSURANCE', title: '', reference: '', expiresOn: '' });
      onAdded();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-label="Add a document" className="form">
      <div className="form__row">
        <SelectField label="Kind" value={form.kind} onChange={set('kind')}>
          {Object.entries(KIND_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Title"
          value={form.title}
          maxLength={160}
          onChange={set('title')}
          required
        />
        <TextField
          label="Policy or licence number (optional)"
          value={form.reference}
          maxLength={120}
          onChange={set('reference')}
        />
        <TextField
          label="Valid until (optional)"
          type="date"
          value={form.expiresOn}
          onChange={set('expiresOn')}
        />
      </div>
      {error ? <Alert>{errorMessage(error)}</Alert> : null}
      <div className="form__actions">
        <Button type="submit" busy={busy}>
          Add document
        </Button>
      </div>
    </form>
  );
}

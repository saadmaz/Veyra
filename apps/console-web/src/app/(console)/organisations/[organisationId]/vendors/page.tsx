'use client';

import type { OrganisationDetailResponse, VendorDetailDto, VendorDto } from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  TextField,
} from '@/components/ui';
import { ComplianceBadge } from '@/components/vendors';
import { ApiRequestError, api } from '@/lib/api-client';
import { CATEGORY_LABELS } from '@/lib/maintenance';
import { errorMessage, fieldErrors } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';

/** The organisation's vendors: who they are, what they do, and whether their papers are in order. */
export default function VendorsPage() {
  const { organisationId } = useParams<{ organisationId: string }>();
  const base = `/organisations/${organisationId}`;
  const organisation = useApiQuery<OrganisationDetailResponse>(base);
  const canRead =
    organisation.status === 'success' &&
    organisation.data.permissions.includes('organisation.vendor.read');
  const vendors = useApiQuery<{ data: VendorDto[] }>(canRead ? `${base}/vendors` : null);

  useEffect(() => {
    document.title = 'Vendors · VEYRA Console';
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
  const crumbs = (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link href={base}>{organisation.data.name}</Link>
    </nav>
  );
  if (!canRead) {
    return (
      <>
        {crumbs}
        <div className="page__header">
          <h1>Vendors</h1>
        </div>
        <EmptyState title="You cannot see vendors">
          Organisation admins and finance officers see the vendor register.
        </EmptyState>
      </>
    );
  }
  const canManage = organisation.data.permissions.includes('organisation.vendor.manage');
  const rows = vendors.status === 'success' ? vendors.data.data : [];
  return (
    <>
      {crumbs}
      <div className="page__header">
        <h1>Vendors</h1>
      </div>
      <Card title="Register">
        {vendors.status === 'loading' ? <LoadingState label="Loading vendors" /> : null}
        {vendors.status === 'error' ? (
          <ErrorState error={vendors.error} onRetry={vendors.reload} />
        ) : null}
        {vendors.status === 'success' && rows.length === 0 ? (
          <p className="muted">No vendors yet.</p>
        ) : null}
        {rows.length > 0 ? (
          <ul className="list" aria-label="Vendors">
            {rows.map((v) => (
              <li key={v.id} className="list__item">
                <div>
                  <p className="list__primary">
                    <Link href={`${base}/vendors/${v.id}`}>{v.name}</Link>{' '}
                    <ComplianceBadge vendor={v} />
                  </p>
                  <p className="list__meta">
                    {v.categories.map((c) => CATEGORY_LABELS[c]).join(', ') || 'No trades listed'}
                    {v.contactName ? ` · ${v.contactName}` : ''}
                    {v.phone ? ` · ${v.phone}` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
      {canManage ? <AddVendor base={base} /> : null}
    </>
  );
}

function AddVendor({ base }: { base: string }) {
  const router = useRouter();
  const [form, setForm] = useState({ name: '', contactName: '', email: '', phone: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<VendorDetailDto>(`${base}/vendors`, {
        name: form.name,
        contactName: form.contactName || null,
        email: form.email || null,
        phone: form.phone || null,
      });
      router.push(`${base}/vendors/${created.vendor.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const errors = fieldErrors(error);
  return (
    <Card title="Add a vendor">
      <form onSubmit={submit} aria-label="Add a vendor" className="form">
        <div className="form__row">
          <TextField
            label="Name"
            value={form.name}
            maxLength={160}
            onChange={set('name')}
            error={errors.name}
            required
          />
          <TextField
            label="Contact person (optional)"
            value={form.contactName}
            maxLength={160}
            onChange={set('contactName')}
          />
        </div>
        <div className="form__row">
          <TextField
            label="Email (optional)"
            type="email"
            value={form.email}
            onChange={set('email')}
            error={errors.email}
          />
          <TextField
            label="Phone (optional)"
            type="tel"
            value={form.phone}
            onChange={set('phone')}
            error={errors.phone}
          />
        </div>
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
        <div className="form__actions">
          <Button type="submit" busy={busy}>
            Add vendor
          </Button>
        </div>
      </form>
    </Card>
  );
}

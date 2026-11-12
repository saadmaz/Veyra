'use client';

import type {
  DocumentAudience,
  DocumentCategory,
  DocumentDto,
  DocumentUploadDto,
  PropertyDetailResponse,
} from '@veyra/api-contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { DocumentItem } from '@/components/documents';
import { BookingAction } from '@/components/facilities';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  SelectField,
  TextField,
} from '@/components/ui';
import { ApiRequestError, api } from '@/lib/api-client';
import {
  CATEGORY_LABELS,
  DOCUMENT_AUDIENCE_LABELS,
  documentFileProblem,
  uploadDocument,
} from '@/lib/communications';
import { errorMessage } from '@/lib/messages';
import { useApiQuery } from '@/lib/use-api';

/** A property's documents for staff: managers add, update and archive them; staff read theirs. */
export default function DocumentsPage() {
  const { organisationId, propertyId } = useParams<{
    organisationId: string;
    propertyId: string;
  }>();
  const base = `/organisations/${organisationId}/properties/${propertyId}`;
  const property = useApiQuery<PropertyDetailResponse>(base);
  const canRead =
    property.status === 'success' && property.data.permissions.includes('property.document.read');
  const documents = useApiQuery<{ data: DocumentDto[] }>(canRead ? `${base}/documents` : null);

  useEffect(() => {
    if (property.status === 'success')
      document.title = `Documents · ${property.data.name} · VEYRA Console`;
  }, [property]);

  if (property.status === 'loading') return <LoadingState label="Loading property" />;
  if (property.status === 'error') {
    if (property.error instanceof ApiRequestError && property.error.status === 404) {
      return (
        <EmptyState title="Property not found">
          It does not exist, or you do not have access to it.
        </EmptyState>
      );
    }
    return <ErrorState error={property.error} onRetry={property.reload} />;
  }
  const p = property.data;
  const crumbs = (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link href={base}>{p.name}</Link>
    </nav>
  );
  if (!canRead) {
    return (
      <>
        {crumbs}
        <div className="page__header">
          <h1>Documents</h1>
        </div>
        <EmptyState title="You cannot see documents here">
          Staff of the property read its documents here.
        </EmptyState>
      </>
    );
  }
  const canManage = p.permissions.includes('property.document.manage');
  const rows = documents.status === 'success' ? documents.data.data : [];
  const path = `${base}/documents`;

  return (
    <>
      {crumbs}
      <div className="page__header">
        <h1>Documents</h1>
      </div>
      <Card title="Library">
        {documents.status === 'loading' ? <LoadingState label="Loading documents" /> : null}
        {documents.status === 'error' ? (
          <ErrorState error={documents.error} onRetry={documents.reload} />
        ) : null}
        {documents.status === 'success' && rows.length === 0 ? (
          <p className="muted">No documents yet.</p>
        ) : null}
        {rows.length > 0 ? (
          <ul className="list" aria-label="Documents">
            {rows.map((d) => (
              <li key={d.id} className="list__item">
                <DocumentItem
                  document={d}
                  downloadPath={`${path}/${d.id}/download`}
                  showAudience={canManage}
                >
                  {canManage && d.status === 'ACTIVE' ? (
                    <>
                      <NewVersion path={path} document={d} onDone={documents.reload} />
                      <BookingAction
                        label="Archive"
                        path={`${path}/${d.id}/archive`}
                        reason="none"
                        variant="danger"
                        onDone={documents.reload}
                      />
                    </>
                  ) : null}
                </DocumentItem>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
      {canManage ? <AddDocument path={path} onDone={documents.reload} /> : null}
    </>
  );
}

function NewVersion({
  path,
  document: d,
  onDone,
}: {
  path: string;
  document: DocumentDto;
  onDone: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = `version-${d.id}`;
  async function choose(file: File | undefined) {
    if (!file) return;
    const problem = documentFileProblem(file);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await uploadDocument(
        () =>
          api.post<DocumentUploadDto>(`${path}/${d.id}/versions`, {
            file: { fileName: file.name, contentType: file.type, sizeBytes: file.size },
          }),
        path,
        file,
      );
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {busy ? 'Uploading…' : `New version of ${d.title}`}
      </label>
      <input
        id={id}
        type="file"
        accept="application/pdf,image/*"
        onChange={(e) => choose(e.target.files?.[0])}
      />
      {error ? <Alert>{error}</Alert> : null}
    </div>
  );
}

function AddDocument({ path, onDone }: { path: string; onDone: () => void }) {
  const [form, setForm] = useState({
    title: '',
    category: 'RULES' as DocumentCategory,
    audience: 'EVERYONE' as DocumentAudience,
    expiresOn: '',
  });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = file ? documentFileProblem(file) : 'Choose a file.';
    if (problem || !file) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await uploadDocument(
        () =>
          api.post<DocumentUploadDto>(path, {
            title: form.title,
            category: form.category,
            audience: form.audience,
            expiresOn: form.expiresOn || null,
            file: { fileName: file.name, contentType: file.type, sizeBytes: file.size },
          }),
        path,
        file,
      );
      setForm((f) => ({ ...f, title: '', expiresOn: '' }));
      setDone(true);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Add a document">
      <form onSubmit={submit} aria-label="Add a document" className="form">
        <div className="form__row">
          <TextField
            label="Title"
            value={form.title}
            maxLength={160}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            required
          />
          <SelectField
            label="Category"
            value={form.category}
            onChange={(e) =>
              setForm((f) => ({ ...f, category: e.target.value as DocumentCategory }))
            }
          >
            {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Who can read it"
            value={form.audience}
            onChange={(e) =>
              setForm((f) => ({ ...f, audience: e.target.value as DocumentAudience }))
            }
          >
            {Object.entries(DOCUMENT_AUDIENCE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Valid until (optional)"
            type="date"
            value={form.expiresOn}
            onChange={(e) => setForm((f) => ({ ...f, expiresOn: e.target.value }))}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="document-file">
            File (PDF or photo, up to 20 MB)
          </label>
          <input
            id="document-file"
            type="file"
            accept="application/pdf,image/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
        {error ? <Alert>{error}</Alert> : null}
        {done ? <Alert tone="success">Added.</Alert> : null}
        <div className="form__actions">
          <Button type="submit" busy={busy}>
            Add document
          </Button>
        </div>
      </form>
    </Card>
  );
}

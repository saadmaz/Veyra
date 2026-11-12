'use client';

import type { AttachmentDownloadDto, DocumentDto } from '@veyra/api-contracts';
import { useState } from 'react';
import { Alert, Badge, Button } from '@/components/ui';
import { api } from '@/lib/api-client';
import { CATEGORY_LABELS, DOCUMENT_AUDIENCE_LABELS, expiryText } from '@/lib/communications';
import { formatBytes } from '@/lib/maintenance';
import { errorMessage } from '@/lib/messages';

/** One document in a list, with a button that opens its current version. */
export function DocumentItem({
  document: d,
  downloadPath,
  showAudience = false,
  children,
}: {
  document: DocumentDto;
  downloadPath: string;
  showAudience?: boolean;
  children?: React.ReactNode;
}) {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const expiry = expiryText(d);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const link = await api.get<AttachmentDownloadDto>(downloadPath);
      window.open(link.url, '_blank', 'noopener');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div>
        <p className="list__primary">
          {d.title} <Badge>{CATEGORY_LABELS[d.category]}</Badge>{' '}
          {d.status === 'ARCHIVED' ? <Badge>archived</Badge> : null}
          {d.expiry === 'EXPIRED' ? <Badge tone="danger">expired</Badge> : null}
          {d.expiry === 'EXPIRING_SOON' ? <Badge tone="warning">expires soon</Badge> : null}
        </p>
        <p className="list__meta">
          {d.current
            ? `${d.current.fileName} · ${formatBytes(d.current.sizeBytes)} · version ${d.current.versionNumber}`
            : 'No file yet'}
          {showAudience ? ` · ${DOCUMENT_AUDIENCE_LABELS[d.audience]}` : ''}
          {expiry ? ` · ${expiry}` : ''}
        </p>
        {d.description ? <p className="list__meta">{d.description}</p> : null}
        {error ? <Alert>{errorMessage(error)}</Alert> : null}
      </div>
      <div className="form__actions">
        {d.current ? (
          <Button variant="secondary" busy={busy} onClick={open}>
            Open
          </Button>
        ) : null}
        {children}
      </div>
    </>
  );
}

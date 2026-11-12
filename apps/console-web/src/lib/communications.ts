import type {
  AnnouncementAudience,
  DocumentAudience,
  DocumentCategory,
  DocumentDetailDto,
  DocumentDto,
  DocumentUploadDto,
} from '@veyra/api-contracts';
import { ApiRequestError, api } from './api-client';
import { ACCEPTED_FILE_TYPES } from './maintenance';

/*
 * Communications helpers for the console (Phase 10): announcements, notifications and documents.
 * The API decides who sees what; these only shape what is shown.
 */

export const AUDIENCE_LABELS: Record<AnnouncementAudience, string> = {
  EVERYONE: 'Everyone (residents and staff)',
  RESIDENTS: 'All residents',
  BUILDING_RESIDENTS: 'Residents of one building',
  STAFF: 'Staff only',
};

export const DOCUMENT_AUDIENCE_LABELS: Record<DocumentAudience, string> = {
  EVERYONE: 'Everyone',
  RESIDENTS: 'Residents',
  OWNERS: 'Owners only',
  STAFF: 'Staff only',
};

export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  RULES: 'Rules',
  MINUTES: 'Minutes',
  NOTICE: 'Notice',
  FORM: 'Form',
  FINANCIAL: 'Financial',
  CONTRACT: 'Contract',
  INSURANCE: 'Insurance',
  OTHER: 'Other',
};

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** A problem with a chosen document file before anything is sent, or null. */
export function documentFileProblem(file: { type: string; size: number }): string | null {
  if (!(ACCEPTED_FILE_TYPES as string[]).includes(file.type)) {
    return 'Choose a PDF or a photo (JPEG, PNG, WebP or HEIC).';
  }
  if (file.size === 0) return 'This file is empty.';
  if (file.size > MAX_DOCUMENT_BYTES) return 'Documents can be at most 20 MB.';
  return null;
}

/** "Valid until 31 Dec 2026", "Expired on …", or nothing. */
export function expiryText(d: Pick<DocumentDto, 'expiresOn' | 'expiry'>): string | null {
  if (!d.expiresOn) return null;
  if (d.expiry === 'EXPIRED') return `Expired on ${d.expiresOn}`;
  if (d.expiry === 'EXPIRING_SOON') return `Expires soon (${d.expiresOn})`;
  return `Valid until ${d.expiresOn}`;
}

/**
 * Uploads a document file the way the API asks (ADR 0007): the API hands out a signed URL with the
 * new version, the browser PUTs the bytes straight to storage, then the API checks them.
 */
export async function uploadDocument(
  start: () => Promise<DocumentUploadDto>,
  base: string,
  file: File,
  fetchImpl: typeof fetch = fetch,
): Promise<DocumentDetailDto> {
  const asked = await start();
  let stored: Response;
  try {
    stored = await fetchImpl(asked.upload.url, {
      method: 'PUT',
      headers: asked.upload.headers,
      body: file,
    });
  } catch {
    throw new ApiRequestError(0, 'UPLOAD_FAILED', 'The file could not be uploaded');
  }
  if (!stored.ok) throw new ApiRequestError(stored.status, 'UPLOAD_FAILED', 'Upload refused');
  return api.post<DocumentDetailDto>(
    `${base}/${asked.document.id}/versions/${asked.versionId}/complete`,
  );
}

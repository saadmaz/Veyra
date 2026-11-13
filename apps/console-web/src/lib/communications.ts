import type { DocumentDetailDto, DocumentUploadDto } from '@veyra/api-contracts';
import { uploadDocument as upload } from '@veyra/client/communications';
import { api } from './api-client';

export * from '@veyra/client/communications';

/** Uploads a chosen browser file as a new document version (ADR 0007). */
export function uploadDocument(
  start: () => Promise<DocumentUploadDto>,
  base: string,
  file: File,
  fetchImpl: typeof fetch = fetch,
): Promise<DocumentDetailDto> {
  return upload(
    api,
    start,
    base,
    { name: file.name, type: file.type, size: file.size, body: file },
    fetchImpl,
  );
}

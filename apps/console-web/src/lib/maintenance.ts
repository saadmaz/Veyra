import type { MaintenanceAttachmentDto } from '@veyra/api-contracts';
import { uploadFile as upload } from '@veyra/client/maintenance';
import { api } from './api-client';

export * from '@veyra/client/maintenance';

/** Uploads a chosen browser file to a request's or work order's attachments (ADR 0007). */
export function uploadFile(
  base: string,
  file: File,
  extra: { kind?: 'BEFORE' | 'AFTER' | 'OTHER'; visibility?: 'RESIDENT' | 'INTERNAL' } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<MaintenanceAttachmentDto> {
  return upload(
    api,
    base,
    { name: file.name, type: file.type, size: file.size, body: file },
    extra,
    fetchImpl,
  );
}

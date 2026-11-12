import { ApiError } from '../errors/api-error';
import type { FileScanner } from './file-scanner';
import { type ObjectStorage, SNIFF_BYTES, sniffFileType } from './object-storage';

/**
 * Checks an uploaded object before anyone may use it: it must exist, have the announced size and
 * real type, and pass the malware scan. A wrong or infected file is deleted and false returned.
 * A missing upload is 409 (upload again); an unreachable scanner is 503 (try again later), and the
 * file is kept, still pending.
 */
export async function checkUpload(
  storage: ObjectStorage,
  scanner: FileScanner,
  upload: { storageKey: string; sizeBytes: number; contentType: string },
): Promise<boolean> {
  const stored = await storage.stat(upload.storageKey);
  if (!stored) {
    throw new ApiError(409, 'UPLOAD_MISSING', 'The file has not arrived yet. Upload it again.');
  }
  const typeOk =
    stored.sizeBytes === upload.sizeBytes &&
    sniffFileType(await storage.readStart(upload.storageKey, SNIFF_BYTES)) === upload.contentType;
  let ok = typeOk;
  if (typeOk) {
    const verdict = await scanner.scan(
      await storage.readStart(upload.storageKey, upload.sizeBytes),
    );
    if (verdict === 'unavailable') {
      throw new ApiError(
        503,
        'SCAN_UNAVAILABLE',
        'The file could not be checked just now. Try again in a minute.',
      );
    }
    ok = verdict === 'clean';
  }
  if (!ok) await storage.remove(upload.storageKey);
  return ok;
}

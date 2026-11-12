/**
 * Object storage port (S3-compatible: MinIO locally, S3 or Cloudflare R2 in production; ADR
 * 0007). File bytes never pass through the API: browsers upload and download with short-lived
 * signed URLs, and the API checks what arrived before it is used.
 */
export interface ObjectStorage {
  /**
   * A signed PUT for exactly this content type and size. The browser must send the returned
   * headers; storage refuses a different type or length.
   */
  presignUpload(
    key: string,
    file: { contentType: string; sizeBytes: number },
    expiresInSeconds: number,
  ): Promise<{ url: string; headers: Record<string, string> }>;
  /** A signed GET that serves the object with this type and file name. */
  presignDownload(
    key: string,
    file: { contentType: string; fileName: string; inline: boolean },
    expiresInSeconds: number,
  ): Promise<string>;
  /** Size of a stored object, or null when there is none. */
  stat(key: string): Promise<{ sizeBytes: number } | null>;
  /** The first bytes of an object (for checking what it really is). */
  readStart(key: string, bytes: number): Promise<Uint8Array>;
  /** Deletes an object; nothing happens when it does not exist. */
  remove(key: string): Promise<void>;
}

/** Null when no storage is configured: file features answer STORAGE_NOT_CONFIGURED. */
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');

/** File types accepted for uploads: photos and PDFs. No SVG or HTML (they can carry scripts). */
export const ALLOWED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
] as const;
export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

/** How many bytes sniffFileType needs. */
export const SNIFF_BYTES = 32;

const startsWith = (bytes: Uint8Array, prefix: readonly number[], offset = 0) =>
  prefix.every((b, i) => bytes[offset + i] === b);
const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.slice(from, to));

/**
 * What a file really is, from its first bytes (magic numbers), whatever its name or declared
 * type says. Null for anything not allowed.
 */
export function sniffFileType(bytes: Uint8Array): AllowedContentType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (
    ascii(bytes, 4, 8) === 'ftyp' &&
    ['heic', 'heix', 'mif1', 'msf1'].includes(ascii(bytes, 8, 12))
  )
    return 'image/heic';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/**
 * A file name safe to show and to put in a Content-Disposition header: no paths, no control
 * characters, no quotes, at most 200 characters, never empty.
 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters.
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '').trim();
  return (cleaned || 'file').slice(0, 200);
}

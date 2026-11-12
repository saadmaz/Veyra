import type { ObjectStorage } from '../../src/platform/storage/object-storage';

const BASE = 'https://storage.example.test/';

/**
 * In-memory object storage for API tests. A signed upload URL names the key; the test plays the
 * browser by calling put(). The real adapter is proven by s3-object-storage.int.test.ts.
 */
export class FakeObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();
  readonly signed = new Map<string, { contentType: string; sizeBytes: number }>();

  async presignUpload(key: string, file: { contentType: string; sizeBytes: number }) {
    this.signed.set(key, file);
    return { url: `${BASE}${key}?signature=upload`, headers: { 'Content-Type': file.contentType } };
  }

  async presignDownload(key: string, file: { fileName: string }) {
    return `${BASE}${key}?signature=download&name=${encodeURIComponent(file.fileName)}`;
  }

  async stat(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { sizeBytes: bytes.length } : null;
  }

  async readStart(key: string, bytes: number) {
    return (this.objects.get(key) ?? new Uint8Array()).slice(0, bytes);
  }

  async remove(key: string) {
    this.objects.delete(key);
  }

  /** What a browser does with the signed URL (without the signature checks). */
  put(url: string, bytes: Uint8Array) {
    const key = new URL(url).pathname.slice(1);
    if (!this.signed.has(key)) throw new Error('No signed upload for this key');
    this.objects.set(key, bytes);
    return key;
  }
}

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sniffFileType } from '../../src/platform/storage/object-storage';
import { S3ObjectStorage } from '../../src/platform/storage/s3-object-storage';

/**
 * Contract test of the S3 adapter against a real S3-compatible server that checks signatures
 * (SeaweedFS from docker-compose.yml locally, started by CI). Skipped without
 * STORAGE_TEST_ENDPOINT. The point is what the browser relies on: a signed upload works only for
 * the declared type and size, and a signed download serves the stored bytes with our headers.
 */

const endpoint = process.env.STORAGE_TEST_ENDPOINT;
const storage = endpoint
  ? new S3ObjectStorage({
      endpoint,
      region: 'us-east-1',
      bucket: process.env.STORAGE_TEST_BUCKET ?? 'veyra-dev',
      accessKeyId: process.env.STORAGE_TEST_ACCESS_KEY_ID ?? 'veyra',
      secretAccessKey: process.env.STORAGE_TEST_SECRET_ACCESS_KEY ?? 'veyra-storage-dev',
      forcePathStyle: true,
    })
  : null;

/** A tiny but real PNG header followed by padding. */
const png = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...new Array(56).fill(7),
]);

const put = (url: string, headers: Record<string, string>, body: Uint8Array) =>
  fetch(url, { method: 'PUT', headers, body });

describe.skipIf(!storage)('S3ObjectStorage against a real server', () => {
  const s = storage as S3ObjectStorage;

  it('accepts an upload of exactly the signed type and size, and serves it back', async () => {
    const key = `test/${randomUUID()}`;
    const signed = await s.presignUpload(
      key,
      { contentType: 'image/png', sizeBytes: png.length },
      60,
    );
    const res = await put(signed.url, signed.headers, png);
    expect(res.status).toBe(200);
    expect(await s.stat(key)).toEqual({ sizeBytes: png.length });
    expect(sniffFileType(await s.readStart(key, 32))).toBe('image/png');

    const url = await s.presignDownload(
      key,
      { contentType: 'image/png', fileName: 'Kitchen leak.png', inline: false },
      60,
    );
    const got = await fetch(url);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-disposition')).toContain(
      'attachment; filename="Kitchen leak.png"',
    );
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(png);

    await s.remove(key);
    expect(await s.stat(key)).toBeNull();
    // Removing again is fine.
    await s.remove(key);
  });

  it('refuses an upload with another type or another size than signed', async () => {
    const key = `test/${randomUUID()}`;
    const signed = await s.presignUpload(
      key,
      { contentType: 'image/png', sizeBytes: png.length },
      60,
    );
    const otherType = await put(signed.url, { 'Content-Type': 'text/html' }, png);
    expect(otherType.status).toBeGreaterThanOrEqual(400);
    const bigger = await put(signed.url, signed.headers, new Uint8Array([...png, 1, 2, 3]));
    expect(bigger.status).toBeGreaterThanOrEqual(400);
    expect(await s.stat(key)).toBeNull();
  });

  it('refuses unsigned access', async () => {
    const res = await fetch(`${endpoint}/${process.env.STORAGE_TEST_BUCKET ?? 'veyra-dev'}/x`);
    expect(res.status).toBe(403);
  });
});

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectStorage } from './object-storage';

export interface S3StorageConfig {
  /** Omit for AWS S3; e.g. http://localhost:8333 for local SeaweedFS, the account URL for R2. */
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Self-hosted servers need path-style URLs (http://host/bucket/key). */
  forcePathStyle: boolean;
}

const notFound = (error: unknown) =>
  error instanceof S3ServiceException &&
  (error.$metadata.httpStatusCode === 404 ||
    error.name === 'NotFound' ||
    error.name === 'NoSuchKey');

/** RFC 6266 filename for an already-safe name (see safeFileName), with a UTF-8 variant. */
function disposition(fileName: string, inline: boolean): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/** The S3-compatible adapter: AWS S3, Cloudflare R2, SeaweedFS. */
export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly config: S3StorageConfig) {
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // Signed URLs must not carry checksum parameters a browser upload cannot satisfy.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async presignUpload(
    key: string,
    file: { contentType: string; sizeBytes: number },
    expiresInSeconds: number,
  ) {
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ContentType: file.contentType,
      ContentLength: file.sizeBytes,
    });
    // Type and length are part of the signature: storage refuses any other upload.
    const url = await getSignedUrl(this.client, command, {
      expiresIn: expiresInSeconds,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return { url, headers: { 'Content-Type': file.contentType } };
  }

  presignDownload(
    key: string,
    file: { contentType: string; fileName: string; inline: boolean },
    expiresInSeconds: number,
  ) {
    const command = new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ResponseContentType: file.contentType,
      ResponseContentDisposition: disposition(file.fileName, file.inline),
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async stat(key: string) {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return { sizeBytes: Number(head.ContentLength ?? 0) };
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  async readStart(key: string, bytes: number) {
    const object = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }),
    );
    if (!object.Body) return new Uint8Array();
    return object.Body.transformToByteArray();
  }

  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }
}

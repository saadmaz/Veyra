import { describe, expect, it } from 'vitest';
import { AttachmentsService } from '../../src/modules/maintenance/application/attachments.service';
import type { MaintenanceRepository } from '../../src/modules/maintenance/application/maintenance-ports';
import { uploadSchema } from '../../src/modules/maintenance/domain/maintenance-rules';
import { apiEnvSchema } from '../../src/platform/config/env';
import { safeFileName, sniffFileType } from '../../src/platform/storage/object-storage';

const bytes = (...values: (number | string)[]) =>
  new Uint8Array(
    values.flatMap((v) => (typeof v === 'string' ? [...v].map((c) => c.charCodeAt(0)) : [v])),
  );

describe('sniffFileType', () => {
  it('recognises photos and PDFs by their first bytes', () => {
    expect(sniffFileType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffFileType(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffFileType(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('image/webp');
    expect(sniffFileType(bytes(0, 0, 0, 24, 'ftypheic'))).toBe('image/heic');
    expect(sniffFileType(bytes('%PDF-1.7'))).toBe('application/pdf');
  });

  it('refuses everything else, whatever it is called', () => {
    expect(sniffFileType(bytes('<svg xmlns'))).toBeNull();
    expect(sniffFileType(bytes('<html>'))).toBeNull();
    expect(sniffFileType(bytes('MZ'))).toBeNull();
    expect(sniffFileType(new Uint8Array())).toBeNull();
  });
});

describe('safeFileName', () => {
  it('keeps the name only, without paths, quotes or control characters', () => {
    expect(safeFileName('C:\\Users\\me\\leak.jpg')).toBe('leak.jpg');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('a"b<c>\u0000d.png')).toBe('abcd.png');
    expect(safeFileName('   ')).toBe('file');
    expect(safeFileName('x'.repeat(300))).toHaveLength(200);
    expect(safeFileName('Küche – Wasserhahn.jpg')).toBe('Küche – Wasserhahn.jpg');
  });
});

describe('uploads', () => {
  it('accept photos and PDFs up to 10 MB', () => {
    const ok = { fileName: 'a.jpg', contentType: 'image/jpeg', sizeBytes: 1024 };
    expect(uploadSchema.parse(ok)).toMatchObject({ kind: 'OTHER', visibility: 'INTERNAL' });
    expect(uploadSchema.safeParse({ ...ok, contentType: 'image/gif' }).success).toBe(false);
    expect(uploadSchema.safeParse({ ...ok, sizeBytes: 10 * 1024 * 1024 + 1 }).success).toBe(false);
  });

  it('answer STORAGE_NOT_CONFIGURED when no storage is set up', async () => {
    const service = new AttachmentsService({} as MaintenanceRepository, null, {
      now: () => new Date(),
    });
    await expect(
      service.download(
        { userId: 'u', organisationId: 'o', propertyId: 'p', permissions: new Set() },
        { kind: 'staff', manage: true },
        'id',
        { requestId: null, ipAddress: null, userAgent: null },
      ),
    ).rejects.toMatchObject({ code: 'STORAGE_NOT_CONFIGURED', status: 409 });
  });

  it('configuration needs both keys with a bucket', () => {
    const base = {
      DATABASE_URL: 'postgresql://a@b/c',
      REDIS_URL: 'redis://localhost:6379',
    };
    expect(apiEnvSchema.safeParse({ ...base, STORAGE_BUCKET: 'veyra' }).success).toBe(false);
    const parsed = apiEnvSchema.parse({
      ...base,
      STORAGE_BUCKET: 'veyra',
      STORAGE_ACCESS_KEY_ID: 'k',
      STORAGE_SECRET_ACCESS_KEY: 's',
      STORAGE_FORCE_PATH_STYLE: 'true',
    });
    expect(parsed).toMatchObject({ STORAGE_REGION: 'auto', STORAGE_FORCE_PATH_STYLE: true });
  });
});

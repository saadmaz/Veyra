import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { databaseErrorCode } from '@veyra/db';
import { CLOCK, type Clock } from '../../../platform/clock';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import { checkUpload } from '../../../platform/storage/check-upload';
import { FILE_SCANNER, type FileScanner } from '../../../platform/storage/file-scanner';
import {
  OBJECT_STORAGE,
  type ObjectStorage,
  safeFileName,
} from '../../../platform/storage/object-storage';
import type { OrganisationAccess } from '../../access-control';
import type { UploadInput } from '../domain/maintenance-rules';
import {
  type AttachmentRecord,
  MAINTENANCE_REPOSITORY,
  type MaintenanceRepository,
  type MaintenanceUnitOfWork,
} from './maintenance-ports';

/** Who is asking, which decides what they may attach, see and remove. */
export type Viewer =
  | { kind: 'resident'; requestId: string }
  | { kind: 'staff'; manage: boolean }
  | { kind: 'technician'; workOrderId: string };

export type AttachTarget = { requestId: string } | { workOrderId: string };

const UPLOAD_SECONDS = 10 * 60;
const DOWNLOAD_SECONDS = 5 * 60;

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Attachment not found');
const notConfigured = () =>
  new ApiError(409, 'STORAGE_NOT_CONFIGURED', 'File uploads are not set up for this service');

/**
 * Photos and PDFs on maintenance requests and work orders (Phase 7 Part 3, ADR 0007). Browsers
 * upload straight to object storage with a short-lived URL signed for the exact type and size;
 * "complete" then checks what arrived (size, and the file's real type from its first bytes)
 * before anyone can see it, deleting anything else. Residents see resident-visible files of their
 * unit's requests; technicians those of their own work; staff everything. Only the uploader (or
 * a manager) removes a file.
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    @Inject(MAINTENANCE_REPOSITORY) private readonly repository: MaintenanceRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage | null,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(FILE_SCANNER) private readonly scanner: FileScanner,
  ) {}

  /** Records a pending attachment and hands out a signed upload URL for it. */
  async requestUpload(
    access: OrganisationAccess,
    viewer: Viewer,
    target: AttachTarget,
    input: UploadInput,
    meta: RequestMeta,
  ) {
    const storage = this.requireStorage();
    const id = randomUUID();
    const propertyId = this.propertyOf(access);
    const storageKey = `org/${access.organisationId}/prop/${propertyId}/maintenance/${id}`;
    const attachment = await this.inProperty(access, meta, async (uow) => {
      await this.requireTarget(uow, access, viewer, target);
      const visibility = viewer.kind === 'resident' ? 'RESIDENT' : input.visibility;
      if (visibility === 'RESIDENT' && 'workOrderId' in target) {
        const work = await uow.workOrder(target.workOrderId);
        if (!work?.requestId) {
          throw new ApiError(
            422,
            'VALIDATION_FAILED',
            'This work has no request, so there is no resident to show the file to',
          );
        }
      }
      await uow.createAttachment({
        id,
        storageKey,
        requestId: 'requestId' in target ? target.requestId : null,
        workOrderId: 'workOrderId' in target ? target.workOrderId : null,
        fileName: safeFileName(input.fileName),
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        kind: viewer.kind === 'resident' ? 'OTHER' : input.kind,
        visibility,
      });
      return this.mustFind(uow, id);
    });
    const upload = await storage.presignUpload(
      storageKey,
      { contentType: attachment.contentType, sizeBytes: attachment.sizeBytes },
      UPLOAD_SECONDS,
    );
    return {
      attachment,
      upload: {
        url: upload.url,
        method: 'PUT' as const,
        headers: upload.headers,
        expiresAt: new Date(this.clock.now().getTime() + UPLOAD_SECONDS * 1000),
      },
    };
  }

  /**
   * The browser says the upload finished: check the stored object before it is shown. A missing
   * object (the upload has not arrived) is 409 and may be retried; a wrong size or type deletes
   * the object and rejects the attachment (422 FILE_REJECTED).
   */
  async complete(access: OrganisationAccess, viewer: Viewer, id: string, meta: RequestMeta) {
    const storage = this.requireStorage();
    const pending = await this.inProperty(access, meta, async (uow) => {
      const attachment = await this.visible(uow, access, viewer, id);
      this.requireUploader(access, viewer, attachment);
      return attachment;
    });
    if (pending.status === 'READY') return pending;
    if (pending.status === 'REJECTED') throw rejected();

    const ok = await checkUpload(storage, this.scanner, pending);

    const result = await this.inProperty(access, meta, async (uow) => {
      const current = await uow.attachment(id, { lock: true });
      if (!current) throw notFound();
      if (current.status === 'PENDING') {
        await uow.setAttachmentStatus(id, ok ? 'READY' : 'REJECTED');
        await uow.audit({
          action: ok ? 'maintenance.attachment.added' : 'maintenance.attachment.rejected',
          resourceType: 'maintenance_attachment',
          resourceId: id,
          metadata: { contentType: pending.contentType, sizeBytes: pending.sizeBytes },
        });
      }
      return this.mustFind(uow, id);
    });
    if (result.status !== 'READY') throw rejected();
    return result;
  }

  /** A short-lived link that serves the file with its own type and name. */
  async download(access: OrganisationAccess, viewer: Viewer, id: string, meta: RequestMeta) {
    const storage = this.requireStorage();
    const attachment = await this.inProperty(access, meta, (uow) =>
      this.visible(uow, access, viewer, id),
    );
    if (attachment.status !== 'READY') throw notFound();
    const url = await storage.presignDownload(
      attachment.storageKey,
      {
        contentType: attachment.contentType,
        fileName: attachment.fileName,
        // Photos open in the browser; PDFs download.
        inline: attachment.contentType.startsWith('image/'),
      },
      DOWNLOAD_SECONDS,
    );
    return { url, expiresAt: new Date(this.clock.now().getTime() + DOWNLOAD_SECONDS * 1000) };
  }

  /** Hides the attachment (it stays in the history) and deletes the file. */
  async remove(access: OrganisationAccess, viewer: Viewer, id: string, meta: RequestMeta) {
    const storage = this.requireStorage();
    const removed = await this.inProperty(access, meta, async (uow) => {
      const attachment = await this.visible(uow, access, viewer, id, { lock: true });
      if (!(viewer.kind === 'staff' && viewer.manage))
        this.requireUploader(access, viewer, attachment);
      if (attachment.status !== 'READY') {
        throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'Only an uploaded file can be removed');
      }
      await uow.removeAttachment(id);
      await uow.audit({
        action: 'maintenance.attachment.removed',
        resourceType: 'maintenance_attachment',
        resourceId: id,
      });
      return attachment;
    });
    // After the commit: a failure leaves an orphaned object to clean up, never a lost record.
    try {
      await storage.remove(removed.storageKey);
    } catch (error) {
      this.logger.warn(`Could not delete the object of attachment ${id}: ${String(error)}`);
    }
  }

  // ------------------------------------------------------------------ shared

  private async requireTarget(
    uow: MaintenanceUnitOfWork,
    access: OrganisationAccess,
    viewer: Viewer,
    target: AttachTarget,
  ) {
    if (viewer.kind === 'staff' && !viewer.manage) {
      throw new ApiError(403, 'FORBIDDEN', 'You do not have permission to perform this action');
    }
    if ('requestId' in target) {
      const request = await uow.request(target.requestId);
      const mine = viewer.kind !== 'resident' || request?.unitId === access.unitId;
      if (!request || !mine || viewer.kind === 'technician') {
        throw new ApiError(404, 'NOT_FOUND', 'Maintenance request not found');
      }
      return;
    }
    const work = await uow.workOrder(target.workOrderId);
    const allowed =
      viewer.kind === 'staff' ||
      (viewer.kind === 'technician' && work?.assignedToUserId === access.userId);
    if (!work || !allowed) throw new ApiError(404, 'NOT_FOUND', 'Work order not found');
  }

  /** The attachment, if this viewer may see it on the route's request or work order. */
  private async visible(
    uow: MaintenanceUnitOfWork,
    access: OrganisationAccess,
    viewer: Viewer,
    id: string,
    options?: { lock?: boolean },
  ): Promise<AttachmentRecord> {
    const attachment = await uow.attachment(id, options);
    if (!attachment || attachment.removedAt) throw notFound();
    if (viewer.kind === 'resident') {
      const request = await uow.request(viewer.requestId);
      if (
        attachment.requestId !== viewer.requestId ||
        request?.unitId !== access.unitId ||
        attachment.visibility !== 'RESIDENT'
      ) {
        throw notFound();
      }
    } else if (viewer.kind === 'technician') {
      const work = await uow.workOrder(viewer.workOrderId);
      if (
        attachment.workOrderId !== viewer.workOrderId ||
        work?.assignedToUserId !== access.userId
      ) {
        throw notFound();
      }
    }
    return attachment;
  }

  private requireUploader(access: OrganisationAccess, viewer: Viewer, a: AttachmentRecord) {
    if (a.uploadedByUserId !== access.userId && !(viewer.kind === 'staff' && viewer.manage)) {
      throw new ApiError(403, 'NOT_UPLOADER', 'Only the person who uploaded the file can do this');
    }
  }

  private requireStorage(): ObjectStorage {
    if (!this.storage) throw notConfigured();
    return this.storage;
  }

  private async mustFind(uow: MaintenanceUnitOfWork, id: string) {
    const attachment = await uow.attachment(id);
    if (!attachment) throw new Error('Attachment vanished inside its own transaction');
    return attachment;
  }

  private propertyOf(access: OrganisationAccess): string {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    return access.propertyId;
  }

  private async inProperty<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: MaintenanceUnitOfWork) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.repository.inProperty(
        access.organisationId,
        this.propertyOf(access),
        access.userId,
        meta,
        work,
      );
    } catch (error) {
      // The database refused: a finished request, cancelled work, or 10 files already.
      if (databaseErrorCode(error) === '23514') {
        throw new ApiError(
          409,
          'ATTACHMENT_NOT_ALLOWED',
          'No more files can be added here: it is finished, cancelled or already has 10 files',
        );
      }
      throw error;
    }
  }
}

const rejected = () =>
  new ApiError(
    422,
    'FILE_REJECTED',
    'The file is not the photo or PDF it claimed to be, or not the declared size. It was deleted.',
  );

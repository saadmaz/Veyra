import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
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
import {
  audiencesFor,
  type CreateDocumentInput,
  type DocumentReader,
  type NewVersionInput,
  type UpdateDocumentInput,
} from '../domain/document-rules';
import {
  DOCUMENT_REPOSITORY,
  type DocumentRecord,
  type DocumentRepository,
  type DocumentUnitOfWork,
} from './document-ports';

const UPLOAD_SECONDS = 10 * 60;
const DOWNLOAD_SECONDS = 5 * 60;

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Document not found');
const notConfigured = () =>
  new ApiError(409, 'STORAGE_NOT_CONFIGURED', 'File uploads are not set up for this service');
const archived = () => new ApiError(409, 'ARCHIVED', 'This document is archived');

/** A document as a reader sees it: managers get every version, others only the current one. */
export interface DocumentView {
  document: DocumentRecord;
  today: string;
  manager: boolean;
}

/**
 * Documents (Phase 10 Part 3). Managers (property.document.manage) add documents and new versions
 * through signed uploads that are checked before they are shown, edit details and archive. Staff
 * (property.document.read) read active documents for everyone or for staff; a unit's residents
 * (unit.document.read) read those for everyone or residents, and owners also those for owners.
 * Readers download the current (newest ready) version through a link valid for five minutes.
 */
@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly repository: DocumentRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage | null,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(FILE_SCANNER) private readonly scanner: FileScanner,
  ) {}

  /** Staff routes: managers see everything, other staff what is meant for them. */
  staffReader(access: OrganisationAccess): DocumentReader {
    return access.permissions.has('property.document.manage')
      ? { kind: 'manager' }
      : { kind: 'staff' };
  }

  list(access: OrganisationAccess, reader: DocumentReader | 'unit', meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const who = await this.resolve(uow, access, reader);
      const documents = await uow.documents({
        audiences: audiencesFor(who),
        activeOnly: who.kind !== 'manager',
      });
      const today = await uow.today();
      return documents
        .filter((d) => who.kind === 'manager' || d.versions.some((v) => v.status === 'READY'))
        .map((document) => this.view(document, today, who));
    });
  }

  detail(
    access: OrganisationAccess,
    reader: DocumentReader | 'unit',
    id: string,
    meta: RequestMeta,
  ) {
    return this.run(access, meta, async (uow) => {
      const who = await this.resolve(uow, access, reader);
      return this.view(await this.readable(uow, who, id), await uow.today(), who);
    });
  }

  create(access: OrganisationAccess, input: CreateDocumentInput, meta: RequestMeta) {
    const storage = this.requireStorage();
    const versionId = randomUUID();
    return this.run(access, meta, async (uow) => {
      const id = await uow.createDocument({
        title: input.title,
        description: input.description ?? null,
        category: input.category,
        audience: input.audience,
        expiresOn: input.expiresOn ?? null,
      });
      await uow.audit({ action: 'document.created', resourceId: id });
      return this.startUpload(uow, storage, access, id, versionId, input.file, null);
    });
  }

  addVersion(access: OrganisationAccess, id: string, input: NewVersionInput, meta: RequestMeta) {
    const storage = this.requireStorage();
    return this.run(access, meta, async (uow) => {
      const document = await uow.document(id);
      if (!document) throw notFound();
      if (document.status === 'ARCHIVED') throw archived();
      return this.startUpload(
        uow,
        storage,
        access,
        id,
        randomUUID(),
        input.file,
        input.note ?? null,
      );
    });
  }

  /**
   * The upload finished: check the stored object (size and real type) before the version is used.
   * A missing object is 409 and may be retried; a wrong one is deleted and the version rejected.
   */
  async complete(access: OrganisationAccess, id: string, versionId: string, meta: RequestMeta) {
    const storage = this.requireStorage();
    const pending = await this.run(access, meta, async (uow) => {
      const document = await uow.document(id);
      const version = document?.versions.find((v) => v.id === versionId);
      if (!version) throw notFound();
      return version;
    });
    if (pending.status === 'REJECTED') throw rejected();
    if (pending.status === 'PENDING') {
      const ok = await checkUpload(storage, this.scanner, pending);
      await this.run(access, meta, async (uow) => {
        await uow.setVersionStatus(versionId, ok ? 'READY' : 'REJECTED');
        await uow.audit({
          action: ok ? 'document.version.added' : 'document.version.rejected',
          resourceId: id,
          metadata: { versionId },
        });
      });
      if (!ok) throw rejected();
    }
    return this.detail(access, { kind: 'manager' }, id, meta);
  }

  update(access: OrganisationAccess, id: string, input: UpdateDocumentInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const document = await uow.document(id);
      if (!document) throw notFound();
      if (document.status === 'ARCHIVED') throw archived();
      const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      await uow.updateDocument(id, patch);
      await uow.audit({
        action: 'document.updated',
        resourceId: id,
        metadata: { fields: Object.keys(patch).join(',') },
      });
      return this.view(await this.readable(uow, { kind: 'manager' }, id), await uow.today(), {
        kind: 'manager',
      });
    });
  }

  archive(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const document = await uow.document(id);
      if (!document) throw notFound();
      if (document.status === 'ARCHIVED') throw archived();
      await uow.updateDocument(id, { status: 'ARCHIVED' });
      await uow.audit({ action: 'document.archived', resourceId: id });
      return this.view(await this.readable(uow, { kind: 'manager' }, id), await uow.today(), {
        kind: 'manager',
      });
    });
  }

  /** A five-minute link to the current version (managers may ask for any ready version). */
  async download(
    access: OrganisationAccess,
    reader: DocumentReader | 'unit',
    id: string,
    versionId: string | undefined,
    meta: RequestMeta,
  ) {
    const storage = this.requireStorage();
    const version = await this.run(access, meta, async (uow) => {
      const who = await this.resolve(uow, access, reader);
      const document = await this.readable(uow, who, id);
      const ready = document.versions.filter((v) => v.status === 'READY');
      const chosen =
        versionId && who.kind === 'manager' ? ready.find((v) => v.id === versionId) : ready[0];
      if (!chosen) throw notFound();
      return chosen;
    });
    const url = await storage.presignDownload(
      version.storageKey,
      {
        contentType: version.contentType,
        fileName: version.fileName,
        inline: version.contentType.startsWith('image/'),
      },
      DOWNLOAD_SECONDS,
    );
    return { url, expiresAt: new Date(this.clock.now().getTime() + DOWNLOAD_SECONDS * 1000) };
  }

  // ------------------------------------------------------------------ shared

  private async startUpload(
    uow: DocumentUnitOfWork,
    storage: ObjectStorage,
    access: OrganisationAccess,
    documentId: string,
    versionId: string,
    file: { fileName: string; contentType: string; sizeBytes: number },
    note: string | null,
  ) {
    const storageKey = `org/${access.organisationId}/prop/${this.propertyOf(access)}/documents/${versionId}`;
    await uow.createVersion({
      id: versionId,
      documentId,
      storageKey,
      fileName: safeFileName(file.fileName),
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      note,
    });
    const upload = await storage.presignUpload(
      storageKey,
      { contentType: file.contentType, sizeBytes: file.sizeBytes },
      UPLOAD_SECONDS,
    );
    const document = await this.readable(uow, { kind: 'manager' }, documentId);
    return {
      view: this.view(document, await uow.today(), { kind: 'manager' }),
      versionId,
      upload: {
        url: upload.url,
        method: 'PUT' as const,
        headers: upload.headers,
        expiresAt: new Date(this.clock.now().getTime() + UPLOAD_SECONDS * 1000),
      },
    };
  }

  private view(document: DocumentRecord, today: string, who: DocumentReader): DocumentView {
    const manager = who.kind === 'manager';
    return {
      document: manager
        ? document
        : {
            ...document,
            versions: document.versions.filter((v) => v.status === 'READY').slice(0, 1),
          },
      today,
      manager,
    };
  }

  private async readable(uow: DocumentUnitOfWork, who: DocumentReader, id: string) {
    const document = await uow.document(id);
    const audiences = audiencesFor(who);
    if (
      !document ||
      (audiences && (!audiences.includes(document.audience) || document.status !== 'ACTIVE'))
    ) {
      throw notFound();
    }
    return document;
  }

  private async resolve(
    uow: DocumentUnitOfWork,
    access: OrganisationAccess,
    reader: DocumentReader | 'unit',
  ): Promise<DocumentReader> {
    if (reader !== 'unit') return reader;
    if (!access.unitId) throw new Error('Unit route without a resolved unit');
    return { kind: 'resident', owner: await uow.callerOwns(access.unitId) };
  }

  private requireStorage() {
    if (!this.storage) throw notConfigured();
    return this.storage;
  }

  private propertyOf(access: OrganisationAccess) {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    return access.propertyId;
  }

  private async run<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: DocumentUnitOfWork) => Promise<T>,
  ) {
    try {
      return await this.repository.inProperty(
        access.organisationId,
        this.propertyOf(access),
        access.userId,
        meta,
        work,
      );
    } catch (error) {
      if (databaseErrorCode(error) === '23514') {
        throw new ApiError(
          409,
          'INVALID_STATE_TRANSITION',
          'This change is not possible any more. Reload and try again.',
        );
      }
      throw error;
    }
  }
}

const rejected = () =>
  new ApiError(422, 'FILE_REJECTED', 'The file is not what it claims to be, or its size is wrong');

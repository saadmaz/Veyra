import type { RequestMeta } from '../../../platform/request-meta';
import type { DocumentAudience, DocumentCategory } from '../domain/document-rules';

export interface VersionRecord {
  id: string;
  versionNumber: number;
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  note: string | null;
  status: 'PENDING' | 'READY' | 'REJECTED';
  uploadedByName: string;
  createdAt: Date;
  readyAt: Date | null;
}

export interface DocumentRecord {
  id: string;
  title: string;
  description: string | null;
  category: DocumentCategory;
  audience: DocumentAudience;
  expiresOn: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  archivedAt: Date | null;
  createdAt: Date;
  /** Newest first. */
  versions: VersionRecord[];
}

export interface DocumentDetails {
  title: string;
  description: string | null;
  category: DocumentCategory;
  audience: DocumentAudience;
  expiresOn: string | null;
}

/** One transaction in the organisation's RLS context, limited to one property. */
export interface DocumentUnitOfWork {
  today(): Promise<string>;
  /** Whether the caller owns this unit today. */
  callerOwns(unitId: string): Promise<boolean>;
  documents(filter: {
    audiences: DocumentAudience[] | null;
    activeOnly: boolean;
  }): Promise<DocumentRecord[]>;
  document(id: string): Promise<DocumentRecord | null>;
  createDocument(input: DocumentDetails): Promise<string>;
  updateDocument(
    id: string,
    patch: Partial<DocumentDetails> & { status?: 'ARCHIVED' },
  ): Promise<void>;
  createVersion(input: {
    id: string;
    documentId: string;
    storageKey: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    note: string | null;
  }): Promise<void>;
  setVersionStatus(id: string, status: 'READY' | 'REJECTED'): Promise<void>;
  audit(event: {
    action: string;
    resourceId: string;
    metadata?: Record<string, string | number | boolean>;
  }): Promise<void>;
}

export interface DocumentRepository {
  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: DocumentUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export const DOCUMENT_REPOSITORY = Symbol('DOCUMENT_REPOSITORY');

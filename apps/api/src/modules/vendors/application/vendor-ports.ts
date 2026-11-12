import type { Trade } from '@veyra/domain';
import type { RequestMeta } from '../../../platform/request-meta';
import type { DocumentKind, VendorStatus } from '../domain/vendor-rules';

export interface VendorDetails {
  name: string;
  categories: Trade[];
  contactName: string | null;
  email: string | null;
  phone: string | null;
  taxReference: string | null;
  notes: string | null;
}

export interface VendorRecord extends VendorDetails {
  id: string;
  status: VendorStatus;
  statusNote: string | null;
  archivedAt: Date | null;
  createdAt: Date;
}

export interface DocumentRecord {
  id: string;
  vendorId: string;
  kind: DocumentKind;
  title: string;
  reference: string | null;
  /** YYYY-MM-DD. */
  validFrom: string | null;
  expiresOn: string | null;
  createdByName: string;
  createdAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
}

/** One transaction in the organisation's RLS context. */
export interface VendorUnitOfWork {
  /** Today in the organisation's default time zone (YYYY-MM-DD). */
  today(): Promise<string>;
  vendors(status?: VendorStatus): Promise<VendorRecord[]>;
  vendor(id: string): Promise<VendorRecord | null>;
  nameTaken(name: string, exceptId?: string): Promise<boolean>;
  createVendor(input: VendorDetails): Promise<string>;
  updateVendor(
    id: string,
    patch: Partial<VendorDetails> & { status?: VendorStatus; statusNote?: string | null },
  ): Promise<void>;
  openWorkCount(vendorId: string): Promise<number>;
  /** Documents of these vendors, newest first. */
  documents(vendorIds: string[]): Promise<DocumentRecord[]>;
  document(id: string): Promise<DocumentRecord | null>;
  createDocument(input: {
    vendorId: string;
    kind: DocumentKind;
    title: string;
    reference: string | null;
    validFrom: string | null;
    expiresOn: string | null;
  }): Promise<string>;
  voidDocument(id: string, reason: string): Promise<void>;
  audit(event: {
    action: string;
    resourceType: 'vendor' | 'vendor_document';
    resourceId: string;
    metadata?: Record<string, string | number | boolean>;
  }): Promise<void>;
}

export interface VendorRepository {
  inOrganisation<T>(
    organisationId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: VendorUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export const VENDOR_REPOSITORY = Symbol('VENDOR_REPOSITORY');

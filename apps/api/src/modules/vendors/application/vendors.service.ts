import { Inject, Injectable } from '@nestjs/common';
import { databaseErrorCode } from '@veyra/db';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import type { OrganisationAccess } from '../../access-control';
import {
  type CreateVendorInput,
  compliance,
  type DocumentInput,
  type UpdateVendorInput,
  type VendorStatus,
} from '../domain/vendor-rules';
import {
  type DocumentRecord,
  VENDOR_REPOSITORY,
  type VendorRecord,
  type VendorRepository,
  type VendorUnitOfWork,
} from './vendor-ports';

const notFound = () => new ApiError(404, 'NOT_FOUND', 'Vendor not found');
const nameTaken = () => new ApiError(409, 'NAME_TAKEN', 'Another vendor already has this name');
const archived = () => new ApiError(409, 'ARCHIVED', 'This vendor is archived');
const invalidState = (message: string) => new ApiError(409, 'INVALID_STATE_TRANSITION', message);

export interface VendorView {
  vendor: VendorRecord;
  compliance: ReturnType<typeof compliance>;
}

/**
 * The organisation's vendors (Phase 9 Part 1): register, edit, suspend with a reason, reactivate
 * and archive (final, only without open work); compliance documents added and voided, never
 * edited. Read with organisation.vendor.read, change with organisation.vendor.manage.
 */
@Injectable()
export class VendorsService {
  constructor(@Inject(VENDOR_REPOSITORY) private readonly repository: VendorRepository) {}

  list(access: OrganisationAccess, status: VendorStatus | undefined, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const [vendors, today] = await Promise.all([uow.vendors(status), uow.today()]);
      const documents = await uow.documents(vendors.map((v) => v.id));
      return vendors.map((vendor) => ({
        vendor,
        compliance: compliance(
          documents
            .filter((d) => d.vendorId === vendor.id)
            .map((d) => ({ expiresOn: d.expiresOn, voided: d.voidedAt !== null })),
          today,
        ),
      }));
    });
  }

  detail(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, (uow) => this.view(uow, id));
  }

  create(access: OrganisationAccess, input: CreateVendorInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      if (await uow.nameTaken(input.name)) throw nameTaken();
      const id = await uow.createVendor({
        name: input.name,
        categories: input.categories,
        contactName: input.contactName ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        taxReference: input.taxReference ?? null,
        notes: input.notes ?? null,
      });
      await uow.audit({ action: 'vendor.created', resourceType: 'vendor', resourceId: id });
      return this.view(uow, id);
    });
  }

  update(access: OrganisationAccess, id: string, input: UpdateVendorInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const vendor = await this.mustFind(uow, id);
      if (vendor.status === 'ARCHIVED') throw archived();
      if (input.name && (await uow.nameTaken(input.name, id))) throw nameTaken();
      const patch = Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      );
      await uow.updateVendor(id, patch);
      await uow.audit({
        action: 'vendor.updated',
        resourceType: 'vendor',
        resourceId: id,
        metadata: { fields: Object.keys(patch).join(',') },
      });
      return this.view(uow, id);
    });
  }

  suspend(access: OrganisationAccess, id: string, reason: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const vendor = await this.mustFind(uow, id);
      if (vendor.status !== 'ACTIVE') throw invalidState('Only an active vendor can be suspended');
      await uow.updateVendor(id, { status: 'SUSPENDED', statusNote: reason });
      await uow.audit({ action: 'vendor.suspended', resourceType: 'vendor', resourceId: id });
      return this.view(uow, id);
    });
  }

  reactivate(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const vendor = await this.mustFind(uow, id);
      if (vendor.status !== 'SUSPENDED')
        throw invalidState('Only a suspended vendor can be reactivated');
      await uow.updateVendor(id, { status: 'ACTIVE', statusNote: null });
      await uow.audit({ action: 'vendor.reactivated', resourceType: 'vendor', resourceId: id });
      return this.view(uow, id);
    });
  }

  archive(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const vendor = await this.mustFind(uow, id);
      if (vendor.status === 'ARCHIVED') throw archived();
      const open = await uow.openWorkCount(id);
      if (open > 0) {
        throw new ApiError(
          409,
          'OPEN_WORK',
          `This vendor has ${open} open work order(s). Reassign or finish them first.`,
        );
      }
      await uow.updateVendor(id, { status: 'ARCHIVED', statusNote: null });
      await uow.audit({ action: 'vendor.archived', resourceType: 'vendor', resourceId: id });
      return this.view(uow, id);
    });
  }

  addDocument(access: OrganisationAccess, id: string, input: DocumentInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const vendor = await this.mustFind(uow, id);
      if (vendor.status === 'ARCHIVED') throw archived();
      const documentId = await uow.createDocument({
        vendorId: id,
        kind: input.kind,
        title: input.title,
        reference: input.reference ?? null,
        validFrom: input.validFrom ?? null,
        expiresOn: input.expiresOn ?? null,
      });
      await uow.audit({
        action: 'vendor.document.added',
        resourceType: 'vendor_document',
        resourceId: documentId,
        metadata: { vendorId: id, kind: input.kind },
      });
      return this.view(uow, id);
    });
  }

  voidDocument(
    access: OrganisationAccess,
    id: string,
    documentId: string,
    reason: string,
    meta: RequestMeta,
  ) {
    return this.run(access, meta, async (uow) => {
      await this.mustFind(uow, id);
      const document = await uow.document(documentId);
      if (!document || document.vendorId !== id) {
        throw new ApiError(404, 'NOT_FOUND', 'Document not found');
      }
      if (document.voidedAt) throw invalidState('This document is already voided');
      await uow.voidDocument(documentId, reason);
      await uow.audit({
        action: 'vendor.document.voided',
        resourceType: 'vendor_document',
        resourceId: documentId,
        metadata: { vendorId: id },
      });
      return this.view(uow, id);
    });
  }

  // ------------------------------------------------------------------ shared

  private async view(uow: VendorUnitOfWork, id: string) {
    const vendor = await this.mustFind(uow, id);
    const [documents, today] = await Promise.all([uow.documents([id]), uow.today()]);
    return {
      vendor,
      documents,
      compliance: compliance(
        documents.map((d: DocumentRecord) => ({
          expiresOn: d.expiresOn,
          voided: d.voidedAt !== null,
        })),
        today,
      ),
      today,
    };
  }

  private async mustFind(uow: VendorUnitOfWork, id: string) {
    const vendor = await uow.vendor(id);
    if (!vendor) throw notFound();
    return vendor;
  }

  private async run<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: VendorUnitOfWork) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.repository.inOrganisation(access.organisationId, access.userId, meta, work);
    } catch (error) {
      const code = databaseErrorCode(error);
      if (code === '23505') throw nameTaken();
      if (code === '23514') {
        throw invalidState('This change is not possible any more. Reload and try again.');
      }
      throw error;
    }
  }
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { VendorDetailDto, VendorDocumentDto, VendorDto } from '@veyra/api-contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import type { DocumentRecord, VendorRecord } from '../application/vendor-ports';
import { VendorsService } from '../application/vendors.service';
import {
  type Compliance,
  type CreateVendorInput,
  createVendorSchema,
  type DocumentInput,
  documentSchema,
  reasonSchema,
  type UpdateVendorInput,
  updateVendorSchema,
  vendorListQuerySchema,
  voidSchema,
} from '../domain/vendor-rules';

const uuid = new ParseUUIDPipe();
const V = 'vendors';

export const toVendor = (v: VendorRecord, compliance: Compliance): VendorDto => ({
  id: v.id,
  name: v.name,
  categories: v.categories,
  contactName: v.contactName,
  email: v.email,
  phone: v.phone,
  taxReference: v.taxReference,
  notes: v.notes,
  status: v.status,
  statusNote: v.statusNote,
  compliance,
  archivedAt: v.archivedAt?.toISOString() ?? null,
  createdAt: v.createdAt.toISOString(),
});

const toDocument = (d: DocumentRecord, today: string): VendorDocumentDto => ({
  id: d.id,
  kind: d.kind,
  title: d.title,
  reference: d.reference,
  validFrom: d.validFrom,
  expiresOn: d.expiresOn,
  expired: d.voidedAt === null && d.expiresOn !== null && d.expiresOn < today,
  addedBy: d.createdByName,
  createdAt: d.createdAt.toISOString(),
  voidedAt: d.voidedAt?.toISOString() ?? null,
  voidReason: d.voidReason,
});

const toDetail = (d: {
  vendor: VendorRecord;
  documents: DocumentRecord[];
  compliance: Compliance;
  today: string;
}): VendorDetailDto => ({
  vendor: toVendor(d.vendor, d.compliance),
  documents: d.documents.map((doc) => toDocument(doc, d.today)),
});

/** The organisation's vendors and their compliance documents. */
@ApiTags('vendors')
@Controller('organisations/:organisationId')
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Get(V)
  @RequirePermission('organisation.vendor.read')
  @ApiOperation({ summary: 'Vendors by name, with their compliance (at most 500).' })
  async list(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(vendorListQuerySchema))
    query: z.infer<typeof vendorListQuerySchema>,
    @Req() req: Request,
  ): Promise<{ data: VendorDto[] }> {
    const rows = await this.vendors.list(access, query.status, requestMeta(req));
    return { data: rows.map((r) => toVendor(r.vendor, r.compliance)) };
  }

  @Post(V)
  @RequirePermission('organisation.vendor.manage')
  @ApiOperation({ summary: 'Register a vendor.' })
  async create(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(createVendorSchema)) body: CreateVendorInput,
    @Req() req: Request,
  ): Promise<VendorDetailDto> {
    return toDetail(await this.vendors.create(access, body, requestMeta(req)));
  }

  @Get(`${V}/:vendorId`)
  @RequirePermission('organisation.vendor.read')
  @ApiOperation({ summary: 'A vendor with its documents.' })
  async get(
    @CurrentAccess() access: OrganisationAccess,
    @Param('vendorId', uuid) id: string,
    @Req() req: Request,
  ): Promise<VendorDetailDto> {
    return toDetail(await this.vendors.detail(access, id, requestMeta(req)));
  }

  @Patch(`${V}/:vendorId`)
  @RequirePermission('organisation.vendor.manage')
  @ApiOperation({ summary: "Change a vendor's details." })
  async update(
    @CurrentAccess() access: OrganisationAccess,
    @Param('vendorId', uuid) id: string,
    @Body(new ZodValidationPipe(updateVendorSchema)) body: UpdateVendorInput,
    @Req() req: Request,
  ): Promise<VendorDetailDto> {
    return toDetail(await this.vendors.update(access, id, body, requestMeta(req)));
  }

  @Post(`${V}/:vendorId/suspend`)
  @HttpCode(200)
  @RequirePermission('organisation.vendor.manage')
  @ApiOperation({ summary: 'Give the vendor no new work, saying why.' })
  async suspend(
    @CurrentAccess() access: OrganisationAccess,
    @Param('vendorId', uuid) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
    @Req() req: Request,
  ): Promise<VendorDetailDto> {
    return toDetail(await this.vendors.suspend(access, id, body.reason, requestMeta(req)));
  }

  @Post(`${V}/:vendorId/reactivate`)
  @HttpCode(200)
  @RequirePermission('organisation.vendor.manage')
  @ApiOperation({ summary: 'Let a suspended vendor take work again.' })
  async reactivate(
    @CurrentAccess() access: OrganisationAccess,
    @Param('vendorId', uuid) id: string,
    @Req() req: Request,
  ): Promise<VendorDetailDto> {
    return toDetail(await this.vendors.reactivate(access, id, requestMeta(req)));
  }

  @Post(`${V}/:vendorId/archive`)
  @HttpCode(200)
  @RequirePermission('organisation.vendor.manage')
  @ApiOperation({ summary: 'Keep for history only (final; no open work allowed).' })
  async archive(
    @CurrentAccess() access: OrganisationAccess,
    @Param('vendorId', uuid) id: string,
    @Req() req: Request,
  ): Promise<VendorDetailDto> {
    return toDetail(await this.vendors.archive(access, id, requestMeta(req)));
  }

  @Post(`${V}/:vendorId/documents`)
  @RequirePermission('organisation.vendor.manage')
  @ApiOperation({ summary: 'Record an insurance, licence, contract or certificate.' })
  async addDocument(
    @CurrentAccess() access: OrganisationAccess,
    @Param('vendorId', uuid) id: string,
    @Body(new ZodValidationPipe(documentSchema)) body: DocumentInput,
    @Req() req: Request,
  ): Promise<VendorDetailDto> {
    return toDetail(await this.vendors.addDocument(access, id, body, requestMeta(req)));
  }

  @Post(`${V}/:vendorId/documents/:documentId/void`)
  @HttpCode(200)
  @RequirePermission('organisation.vendor.manage')
  @ApiOperation({ summary: 'Void a document recorded by mistake (it stays in the history).' })
  async voidDocument(
    @CurrentAccess() access: OrganisationAccess,
    @Param('vendorId', uuid) id: string,
    @Param('documentId', uuid) documentId: string,
    @Body(new ZodValidationPipe(voidSchema)) body: z.infer<typeof voidSchema>,
    @Req() req: Request,
  ): Promise<VendorDetailDto> {
    return toDetail(
      await this.vendors.voidDocument(access, id, documentId, body.reason, requestMeta(req)),
    );
  }
}

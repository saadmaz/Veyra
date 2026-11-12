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
import type {
  AttachmentContentType,
  AttachmentDownloadDto,
  DocumentDetailDto,
  DocumentDto,
  DocumentUploadDto,
} from '@veyra/api-contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import { DocumentsService, type DocumentView } from '../application/documents.service';
import {
  type CreateDocumentInput,
  createDocumentSchema,
  expiry,
  type NewVersionInput,
  newVersionSchema,
  type UpdateDocumentInput,
  updateDocumentSchema,
} from '../domain/document-rules';

const uuid = new ParseUUIDPipe();
const D = 'properties/:propertyId/documents';
const U = 'properties/:propertyId/units/:unitId/documents';
const versionQuerySchema = z.object({ version: z.uuid().optional() });

const toDocument = (v: DocumentView): DocumentDto => {
  const d = v.document;
  const current = d.versions.find((x) => x.status === 'READY') ?? null;
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    category: d.category,
    audience: d.audience,
    expiresOn: d.expiresOn,
    expiry: expiry(d.expiresOn, v.today),
    status: d.status,
    archivedAt: d.archivedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    current: current
      ? {
          id: current.id,
          versionNumber: current.versionNumber,
          fileName: current.fileName,
          contentType: current.contentType as AttachmentContentType,
          sizeBytes: current.sizeBytes,
          readyAt: current.readyAt?.toISOString() ?? '',
        }
      : null,
  };
};

const toDetail = (v: DocumentView): DocumentDetailDto => ({
  document: toDocument(v),
  versions: v.manager
    ? v.document.versions.map((x) => ({
        id: x.id,
        versionNumber: x.versionNumber,
        fileName: x.fileName,
        contentType: x.contentType,
        sizeBytes: x.sizeBytes,
        note: x.note,
        status: x.status,
        uploadedBy: x.uploadedByName,
        createdAt: x.createdAt.toISOString(),
      }))
    : [],
});

const toUpload = (r: Awaited<ReturnType<DocumentsService['create']>>): DocumentUploadDto => ({
  ...toDetail(r.view),
  versionId: r.versionId,
  upload: { ...r.upload, expiresAt: r.upload.expiresAt.toISOString() },
});

const toLink = (l: { url: string; expiresAt: Date }): AttachmentDownloadDto => ({
  url: l.url,
  expiresAt: l.expiresAt.toISOString(),
});

/** A property's documents: managers keep them, staff read what is meant for them. */
@ApiTags('communications')
@Controller('organisations/:organisationId')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get(D)
  @RequirePermission('property.document.read')
  @ApiOperation({ summary: 'Documents (managers see all, staff those for everyone or staff).' })
  async list(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: DocumentDto[] }> {
    const rows = await this.documents.list(
      access,
      this.documents.staffReader(access),
      requestMeta(req),
    );
    return { data: rows.map(toDocument) };
  }

  @Post(D)
  @RequirePermission('property.document.manage')
  @ApiOperation({ summary: 'Add a document: then PUT the file to the link and complete it.' })
  async create(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(createDocumentSchema)) body: CreateDocumentInput,
    @Req() req: Request,
  ): Promise<DocumentUploadDto> {
    return toUpload(await this.documents.create(access, body, requestMeta(req)));
  }

  @Get(`${D}/:documentId`)
  @RequirePermission('property.document.read')
  @ApiOperation({ summary: 'A document (managers also see every version).' })
  async get(
    @CurrentAccess() access: OrganisationAccess,
    @Param('documentId', uuid) id: string,
    @Req() req: Request,
  ): Promise<DocumentDetailDto> {
    return toDetail(
      await this.documents.detail(access, this.documents.staffReader(access), id, requestMeta(req)),
    );
  }

  @Patch(`${D}/:documentId`)
  @RequirePermission('property.document.manage')
  @ApiOperation({ summary: "Change a document's details." })
  async update(
    @CurrentAccess() access: OrganisationAccess,
    @Param('documentId', uuid) id: string,
    @Body(new ZodValidationPipe(updateDocumentSchema)) body: UpdateDocumentInput,
    @Req() req: Request,
  ): Promise<DocumentDetailDto> {
    return toDetail(await this.documents.update(access, id, body, requestMeta(req)));
  }

  @Post(`${D}/:documentId/archive`)
  @HttpCode(200)
  @RequirePermission('property.document.manage')
  @ApiOperation({ summary: 'Hide a document from readers for good (it stays in the history).' })
  async archive(
    @CurrentAccess() access: OrganisationAccess,
    @Param('documentId', uuid) id: string,
    @Req() req: Request,
  ): Promise<DocumentDetailDto> {
    return toDetail(await this.documents.archive(access, id, requestMeta(req)));
  }

  @Post(`${D}/:documentId/versions`)
  @RequirePermission('property.document.manage')
  @ApiOperation({ summary: 'Upload a new version: then PUT the file and complete it.' })
  async addVersion(
    @CurrentAccess() access: OrganisationAccess,
    @Param('documentId', uuid) id: string,
    @Body(new ZodValidationPipe(newVersionSchema)) body: NewVersionInput,
    @Req() req: Request,
  ): Promise<DocumentUploadDto> {
    return toUpload(await this.documents.addVersion(access, id, body, requestMeta(req)));
  }

  @Post(`${D}/:documentId/versions/:versionId/complete`)
  @HttpCode(200)
  @RequirePermission('property.document.manage')
  @ApiOperation({ summary: 'The upload finished: check the file.' })
  async complete(
    @CurrentAccess() access: OrganisationAccess,
    @Param('documentId', uuid) id: string,
    @Param('versionId', uuid) versionId: string,
    @Req() req: Request,
  ): Promise<DocumentDetailDto> {
    return toDetail(await this.documents.complete(access, id, versionId, requestMeta(req)));
  }

  @Get(`${D}/:documentId/download`)
  @RequirePermission('property.document.read')
  @ApiOperation({ summary: 'A five-minute link to the current version (managers: ?version=).' })
  async download(
    @CurrentAccess() access: OrganisationAccess,
    @Param('documentId', uuid) id: string,
    @Query(new ZodValidationPipe(versionQuerySchema)) query: z.infer<typeof versionQuerySchema>,
    @Req() req: Request,
  ): Promise<AttachmentDownloadDto> {
    return toLink(
      await this.documents.download(
        access,
        this.documents.staffReader(access),
        id,
        query.version,
        requestMeta(req),
      ),
    );
  }
}

/** Documents as a unit's residents see them. */
@ApiTags('communications')
@Controller('organisations/:organisationId')
export class UnitDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get(U)
  @RequirePermission('unit.document.read')
  @ApiOperation({
    summary: 'Documents for residents of this home (owners also see those for owners).',
  })
  async list(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: DocumentDto[] }> {
    return { data: (await this.documents.list(access, 'unit', requestMeta(req))).map(toDocument) };
  }

  @Get(`${U}/:documentId/download`)
  @RequirePermission('unit.document.read')
  @ApiOperation({ summary: 'A five-minute link to the current version.' })
  async download(
    @CurrentAccess() access: OrganisationAccess,
    @Param('documentId', uuid) id: string,
    @Req() req: Request,
  ): Promise<AttachmentDownloadDto> {
    return toLink(await this.documents.download(access, 'unit', id, undefined, requestMeta(req)));
  }
}

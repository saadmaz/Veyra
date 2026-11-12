import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AttachmentDownloadDto,
  AttachmentUploadDto,
  MaintenanceAttachmentDto,
  MaintenanceRequestDto,
  ResidentMaintenanceRequestDetailDto,
} from '@veyra/api-contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import { AttachmentsService } from '../application/attachments.service';
import type {
  AttachmentRecord,
  EventRecord,
  RequestRecord,
} from '../application/maintenance-ports';
import { ResidentMaintenanceService } from '../application/resident-maintenance.service';
import {
  type ResidentRequestInput,
  reasonSchema,
  residentNoteSchema,
  residentRequestSchema,
  type UploadInput,
  uploadSchema,
} from '../domain/maintenance-rules';
import { toDownload, toUpload } from './maintenance.controller';
import { toAttachment, toEvent, toRequest } from './maintenance-dto';

const uuid = new ParseUUIDPipe();
const UNIT = 'properties/:propertyId/units/:unitId/maintenance-requests';

const detail = (d: {
  request: RequestRecord;
  events: EventRecord[];
  attachments: AttachmentRecord[];
}): ResidentMaintenanceRequestDetailDto => ({
  request: toRequest(d.request),
  events: d.events.map(toEvent),
  attachments: d.attachments.map(toAttachment),
});

/**
 * A unit's maintenance requests for its residents (owners, tenants and household members), with
 * resident-visible history only (unit.maintenance.request). Requests of other units are 404.
 */
@ApiTags('maintenance')
@Controller('organisations/:organisationId')
export class UnitMaintenanceController {
  constructor(
    private readonly maintenance: ResidentMaintenanceService,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
  ) {}

  @Post(`${UNIT}/:requestId/attachments`)
  @RequirePermission('unit.maintenance.request')
  @ApiOperation({ summary: 'Ask to upload a photo or PDF (then PUT it and complete).' })
  async upload(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) requestId: string,
    @Body(new ZodValidationPipe(uploadSchema)) body: UploadInput,
    @Req() req: Request,
  ): Promise<AttachmentUploadDto> {
    return toUpload(
      await this.attachments.requestUpload(
        access,
        { kind: 'resident', requestId },
        { requestId },
        body,
        requestMeta(req),
      ),
    );
  }

  @Post(`${UNIT}/:requestId/attachments/:attachmentId/complete`)
  @HttpCode(200)
  @RequirePermission('unit.maintenance.request')
  @ApiOperation({ summary: 'Your upload finished: check the file.' })
  async complete(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) requestId: string,
    @Param('attachmentId', uuid) id: string,
    @Req() req: Request,
  ): Promise<MaintenanceAttachmentDto> {
    return toAttachment(
      await this.attachments.complete(
        access,
        { kind: 'resident', requestId },
        id,
        requestMeta(req),
      ),
    );
  }

  @Get(`${UNIT}/:requestId/attachments/:attachmentId/download`)
  @RequirePermission('unit.maintenance.request')
  @ApiOperation({ summary: 'A link to a file, valid for a few minutes.' })
  async download(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) requestId: string,
    @Param('attachmentId', uuid) id: string,
    @Req() req: Request,
  ): Promise<AttachmentDownloadDto> {
    return toDownload(
      await this.attachments.download(
        access,
        { kind: 'resident', requestId },
        id,
        requestMeta(req),
      ),
    );
  }

  @Post(`${UNIT}/:requestId/attachments/:attachmentId/remove`)
  @HttpCode(204)
  @RequirePermission('unit.maintenance.request')
  @ApiOperation({ summary: 'Remove a file you uploaded.' })
  async remove(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) requestId: string,
    @Param('attachmentId', uuid) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.attachments.remove(access, { kind: 'resident', requestId }, id, requestMeta(req));
  }

  @Get(UNIT)
  @RequirePermission('unit.maintenance.request')
  @ApiOperation({ summary: "The unit's requests, newest first (at most 200)." })
  async list(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: MaintenanceRequestDto[] }> {
    const rows = await this.maintenance.list(access, requestMeta(req));
    return { data: rows.map(toRequest) };
  }

  @Post(UNIT)
  @RequirePermission('unit.maintenance.request')
  @ApiOperation({ summary: 'Report a problem in the unit.' })
  async create(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(residentRequestSchema)) body: ResidentRequestInput,
    @Req() req: Request,
  ): Promise<ResidentMaintenanceRequestDetailDto> {
    return detail(await this.maintenance.create(access, body, requestMeta(req)));
  }

  @Get(`${UNIT}/:requestId`)
  @RequirePermission('unit.maintenance.request')
  @ApiOperation({ summary: 'A request with its updates.' })
  async get(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) id: string,
    @Req() req: Request,
  ): Promise<ResidentMaintenanceRequestDetailDto> {
    return detail(await this.maintenance.detail(access, id, requestMeta(req)));
  }

  @Post(`${UNIT}/:requestId/cancel`)
  @HttpCode(200)
  @RequirePermission('unit.maintenance.request')
  @ApiOperation({ summary: 'Withdraw your own request before work starts.' })
  async cancel(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
    @Req() req: Request,
  ): Promise<ResidentMaintenanceRequestDetailDto> {
    return detail(await this.maintenance.cancel(access, id, body.reason, requestMeta(req)));
  }

  @Post(`${UNIT}/:requestId/confirm`)
  @HttpCode(200)
  @RequirePermission('unit.maintenance.request')
  @ApiOperation({ summary: 'The work is done: close the request (residents only).' })
  async confirm(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) id: string,
    @Req() req: Request,
  ): Promise<ResidentMaintenanceRequestDetailDto> {
    return detail(await this.maintenance.confirm(access, id, requestMeta(req)));
  }

  @Post(`${UNIT}/:requestId/reopen`)
  @HttpCode(200)
  @RequirePermission('unit.maintenance.request')
  @ApiOperation({ summary: 'Not fixed: send it back, saying why (residents only).' })
  async reopen(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
    @Req() req: Request,
  ): Promise<ResidentMaintenanceRequestDetailDto> {
    return detail(await this.maintenance.reopen(access, id, body.reason, requestMeta(req)));
  }

  @Post(`${UNIT}/:requestId/notes`)
  @RequirePermission('unit.maintenance.request')
  @ApiOperation({ summary: 'Add a message for the property team.' })
  async note(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) id: string,
    @Body(new ZodValidationPipe(residentNoteSchema)) body: z.infer<typeof residentNoteSchema>,
    @Req() req: Request,
  ): Promise<ResidentMaintenanceRequestDetailDto> {
    return detail(await this.maintenance.addNote(access, id, body.body, requestMeta(req)));
  }
}

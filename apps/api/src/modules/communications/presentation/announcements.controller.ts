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
import type { AnnouncementDetailDto, AnnouncementDto, InboxItemDto } from '@veyra/api-contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { Authenticated } from '../../../platform/auth/route-access';
import { ApiError } from '../../../platform/errors/api-error';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import { type AuthenticatedPrincipal, CurrentPrincipal } from '../../identity';
import type {
  AnnouncementRecord,
  InboxRecord,
  RecipientRecord,
} from '../application/announcement-ports';
import { AnnouncementsService } from '../application/announcements.service';
import {
  announcementListQuerySchema,
  type DraftInput,
  draftSchema,
  type UpdateDraftInput,
  updateDraftSchema,
  withdrawSchema,
} from '../domain/announcement-rules';

const uuid = new ParseUUIDPipe();
const A = 'properties/:propertyId/announcements';

const toAnnouncement = (a: AnnouncementRecord): AnnouncementDto => ({
  id: a.id,
  property: { id: a.propertyId, name: a.propertyName },
  title: a.title,
  body: a.body,
  priority: a.priority,
  audience: a.audience,
  building: a.buildingId ? { id: a.buildingId, name: a.buildingName ?? '' } : null,
  requiresAcknowledgement: a.requiresAcknowledgement,
  status: a.status,
  publishedAt: a.publishedAt?.toISOString() ?? null,
  publishedBy: a.publishedByName,
  withdrawnAt: a.withdrawnAt?.toISOString() ?? null,
  withdrawReason: a.withdrawReason,
  createdBy: a.createdByName,
  createdAt: a.createdAt.toISOString(),
  delivery: { recipients: a.recipients, read: a.read, acknowledged: a.acknowledged },
});

const toDetail = (d: {
  announcement: AnnouncementRecord;
  recipients: RecipientRecord[];
}): AnnouncementDetailDto => ({
  announcement: toAnnouncement(d.announcement),
  recipients: d.recipients.map((r) => ({
    userId: r.userId,
    name: r.name,
    readAt: r.readAt?.toISOString() ?? null,
    acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
  })),
});

const toInbox = (i: InboxRecord): InboxItemDto => {
  const { delivery: _d, createdBy: _c, ...announcement } = toAnnouncement(i.announcement);
  return {
    announcement,
    readAt: i.readAt?.toISOString() ?? null,
    acknowledgedAt: i.acknowledgedAt?.toISOString() ?? null,
  };
};

/** A property's announcements for managers (drafts, publishing, delivery figures). */
@ApiTags('communications')
@Controller('organisations/:organisationId')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get(A)
  @RequirePermission('property.announcement.read')
  @ApiOperation({ summary: 'Announcements, newest first (at most 200), with delivery figures.' })
  async list(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(announcementListQuerySchema)) query: z.infer<
      typeof announcementListQuerySchema
    >,
    @Req() req: Request,
  ): Promise<{ data: AnnouncementDto[] }> {
    return {
      data: (await this.announcements.list(access, query.status, requestMeta(req))).map(
        toAnnouncement,
      ),
    };
  }

  @Post(A)
  @RequirePermission('property.announcement.manage')
  @ApiOperation({ summary: 'Draft an announcement.' })
  async create(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(draftSchema)) body: DraftInput,
    @Req() req: Request,
  ): Promise<AnnouncementDetailDto> {
    return toDetail(await this.announcements.createDraft(access, body, requestMeta(req)));
  }

  @Get(`${A}/:announcementId`)
  @RequirePermission('property.announcement.read')
  @ApiOperation({ summary: 'An announcement with who received, read and acknowledged it.' })
  async get(
    @CurrentAccess() access: OrganisationAccess,
    @Param('announcementId', uuid) id: string,
    @Req() req: Request,
  ): Promise<AnnouncementDetailDto> {
    return toDetail(await this.announcements.detail(access, id, requestMeta(req)));
  }

  @Patch(`${A}/:announcementId`)
  @RequirePermission('property.announcement.manage')
  @ApiOperation({ summary: 'Change a draft.' })
  async update(
    @CurrentAccess() access: OrganisationAccess,
    @Param('announcementId', uuid) id: string,
    @Body(new ZodValidationPipe(updateDraftSchema)) body: UpdateDraftInput,
    @Req() req: Request,
  ): Promise<AnnouncementDetailDto> {
    return toDetail(await this.announcements.updateDraft(access, id, body, requestMeta(req)));
  }

  @Post(`${A}/:announcementId/publish`)
  @HttpCode(200)
  @RequirePermission('property.announcement.manage')
  @ApiOperation({ summary: 'Publish and deliver to everyone in the audience now.' })
  async publish(
    @CurrentAccess() access: OrganisationAccess,
    @Param('announcementId', uuid) id: string,
    @Req() req: Request,
  ): Promise<AnnouncementDetailDto> {
    return toDetail(await this.announcements.publish(access, id, requestMeta(req)));
  }

  @Post(`${A}/:announcementId/withdraw`)
  @HttpCode(200)
  @RequirePermission('property.announcement.manage')
  @ApiOperation({ summary: 'Take a published announcement back, saying why.' })
  async withdraw(
    @CurrentAccess() access: OrganisationAccess,
    @Param('announcementId', uuid) id: string,
    @Body(new ZodValidationPipe(withdrawSchema)) body: z.infer<typeof withdrawSchema>,
    @Req() req: Request,
  ): Promise<AnnouncementDetailDto> {
    return toDetail(await this.announcements.withdraw(access, id, body.reason, requestMeta(req)));
  }
}

/**
 * The signed-in person's announcements in an organisation. Only their own copies exist for them:
 * someone with nothing delivered in the organisation simply has an empty inbox.
 */
@ApiTags('communications')
@Controller('organisations/:organisationId/inbox')
export class InboxController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  @Authenticated()
  @ApiOperation({ summary: 'Your announcements in this organisation, newest first.' })
  async inbox(
    @Param('organisationId', uuid) organisationId: string,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() req: Request,
  ): Promise<{ data: InboxItemDto[] }> {
    const rows = await this.announcements.inbox(organisationId, principal.userId, requestMeta(req));
    return { data: rows.map(toInbox) };
  }

  @Post(':announcementId/read')
  @HttpCode(200)
  @Authenticated()
  @ApiOperation({ summary: 'Mark an announcement read.' })
  async read(
    @Param('organisationId', uuid) organisationId: string,
    @Param('announcementId', uuid) id: string,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() req: Request,
  ): Promise<InboxItemDto> {
    return toInbox(
      must(await this.announcements.read(organisationId, principal.userId, id, requestMeta(req))),
    );
  }

  @Post(':announcementId/acknowledge')
  @HttpCode(200)
  @Authenticated()
  @ApiOperation({ summary: 'Confirm you have read an announcement that asks for it.' })
  async acknowledge(
    @Param('organisationId', uuid) organisationId: string,
    @Param('announcementId', uuid) id: string,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() req: Request,
  ): Promise<InboxItemDto> {
    return toInbox(
      must(
        await this.announcements.acknowledge(
          organisationId,
          principal.userId,
          id,
          requestMeta(req),
        ),
      ),
    );
  }
}

function must<T>(value: T | null): T {
  if (value === null) throw new ApiError(404, 'NOT_FOUND', 'Announcement not found');
  return value;
}

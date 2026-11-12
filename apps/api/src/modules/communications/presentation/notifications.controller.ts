import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { NotificationDeliveryDto, NotificationDto } from '@veyra/api-contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { Authenticated } from '../../../platform/auth/route-access';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import { type AuthenticatedPrincipal, CurrentPrincipal } from '../../identity';
import { NotificationsService } from '../application/notifications.service';

const uuid = new ParseUUIDPipe();
const deliveryQuerySchema = z.object({ status: z.enum(['PENDING', 'SENT', 'FAILED']).optional() });

/** The signed-in person's notifications in an organisation (their own only). */
@ApiTags('communications')
@Controller('organisations/:organisationId/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @Authenticated()
  @ApiOperation({ summary: 'Your notifications, newest first (at most 100).' })
  async feed(
    @Param('organisationId', uuid) organisationId: string,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Req() req: Request,
  ): Promise<{ data: NotificationDto[]; unread: number }> {
    const rows = await this.notifications.feed(organisationId, principal.userId, requestMeta(req));
    return {
      data: rows.map((n) => ({
        id: n.id,
        propertyId: n.propertyId,
        kind: n.kind,
        title: n.title,
        body: n.body,
        link: n.link,
        urgent: n.urgent,
        createdAt: n.createdAt.toISOString(),
        readAt: n.readAt?.toISOString() ?? null,
      })),
      unread: rows.filter((n) => n.readAt === null).length,
    };
  }

  @Post('read-all')
  @HttpCode(200)
  @Authenticated()
  @ApiOperation({ summary: 'Mark all your notifications read.' })
  async readAll(
    @Param('organisationId', uuid) organisationId: string,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): Promise<{ marked: number }> {
    return { marked: await this.notifications.markAllRead(organisationId, principal.userId) };
  }

  @Post(':notificationId/read')
  @HttpCode(204)
  @Authenticated()
  @ApiOperation({ summary: 'Mark one of your notifications read.' })
  async read(
    @Param('organisationId', uuid) organisationId: string,
    @Param('notificationId', uuid) id: string,
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
  ): Promise<void> {
    await this.notifications.markRead(organisationId, principal.userId, id);
  }
}

/** How email and other deliveries of a property's notifications went, for managers. */
@ApiTags('communications')
@Controller('organisations/:organisationId')
export class DeliveriesController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('properties/:propertyId/notification-deliveries')
  @RequirePermission('property.announcement.read')
  @ApiOperation({
    summary: "Deliveries of the property's notifications, newest first (at most 200).",
  })
  async deliveries(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(deliveryQuerySchema)) query: z.infer<typeof deliveryQuerySchema>,
  ): Promise<{ data: NotificationDeliveryDto[] }> {
    const rows = await this.notifications.deliveries(
      access.organisationId,
      access.userId,
      access.propertyId as string,
      query.status,
    );
    return {
      data: rows.map((d) => ({
        id: d.id,
        channel: d.channel,
        status: d.status,
        attempts: d.attempts,
        lastError: d.lastError,
        sentAt: d.sentAt?.toISOString() ?? null,
        createdAt: d.createdAt.toISOString(),
        kind: d.notification.kind,
        title: d.notification.title,
        recipient: d.notification.recipientName,
      })),
    };
  }
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  WebhookDeliveryDto,
  WebhookEndpointDetailDto,
  WebhookEndpointDto,
  WebhookSecretDto,
} from '@veyra/api-contracts';
import type { Request } from 'express';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import type { DeliveryRecord, EndpointRecord } from '../application/webhook-ports';
import { WebhooksService } from '../application/webhooks.service';
import {
  type EndpointInput,
  endpointSchema,
  type UpdateEndpointInput,
  updateEndpointSchema,
  WEBHOOK_EVENTS,
} from '../domain/webhook-rules';

const uuid = new ParseUUIDPipe();
const W = 'webhooks';

const toEndpoint = (e: EndpointRecord): WebhookEndpointDto => ({
  id: e.id,
  url: e.url,
  description: e.description,
  events: e.events,
  status: e.status,
  createdAt: e.createdAt.toISOString(),
});

const toDelivery = (d: DeliveryRecord): WebhookDeliveryDto => ({
  id: d.id,
  eventType: d.eventType,
  eventId: d.eventId,
  status: d.status,
  attempts: d.attempts,
  lastStatusCode: d.lastStatusCode,
  lastError: d.lastError,
  deliveredAt: d.deliveredAt?.toISOString() ?? null,
  createdAt: d.createdAt.toISOString(),
});

const withSecret = (r: { endpoint: EndpointRecord; secret: string }): WebhookSecretDto => ({
  endpoint: toEndpoint(r.endpoint),
  secret: r.secret,
});

/** An organisation's webhook endpoints and their deliveries. */
@ApiTags('integrations')
@Controller('organisations/:organisationId')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get(`${W}/events`)
  @RequirePermission('organisation.webhook.manage')
  @ApiOperation({ summary: 'The event types an endpoint can subscribe to.' })
  events(): { data: readonly string[] } {
    return { data: WEBHOOK_EVENTS };
  }

  @Get(W)
  @RequirePermission('organisation.webhook.manage')
  @ApiOperation({ summary: 'Webhook endpoints.' })
  async list(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: WebhookEndpointDto[] }> {
    return { data: (await this.webhooks.list(access, requestMeta(req))).map(toEndpoint) };
  }

  @Post(W)
  @RequirePermission('organisation.webhook.manage')
  @ApiOperation({ summary: 'Add an HTTPS endpoint; its signing secret is shown only now.' })
  async create(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(endpointSchema)) body: EndpointInput,
    @Req() req: Request,
  ): Promise<WebhookSecretDto> {
    return withSecret(await this.webhooks.create(access, body, requestMeta(req)));
  }

  @Get(`${W}/:endpointId`)
  @RequirePermission('organisation.webhook.manage')
  @ApiOperation({ summary: 'An endpoint with its latest 50 deliveries.' })
  async get(
    @CurrentAccess() access: OrganisationAccess,
    @Param('endpointId', uuid) id: string,
    @Req() req: Request,
  ): Promise<WebhookEndpointDetailDto> {
    const r = await this.webhooks.detail(access, id, requestMeta(req));
    return { endpoint: toEndpoint(r.endpoint), deliveries: r.deliveries.map(toDelivery) };
  }

  @Patch(`${W}/:endpointId`)
  @RequirePermission('organisation.webhook.manage')
  @ApiOperation({ summary: 'Change the URL, events or description, or disable the endpoint.' })
  async update(
    @CurrentAccess() access: OrganisationAccess,
    @Param('endpointId', uuid) id: string,
    @Body(new ZodValidationPipe(updateEndpointSchema)) body: UpdateEndpointInput,
    @Req() req: Request,
  ): Promise<WebhookEndpointDto> {
    return toEndpoint(await this.webhooks.update(access, id, body, requestMeta(req)));
  }

  @Post(`${W}/:endpointId/rotate-secret`)
  @HttpCode(200)
  @RequirePermission('organisation.webhook.manage')
  @ApiOperation({ summary: 'Replace the signing secret; the new one is shown only now.' })
  async rotate(
    @CurrentAccess() access: OrganisationAccess,
    @Param('endpointId', uuid) id: string,
    @Req() req: Request,
  ): Promise<WebhookSecretDto> {
    return withSecret(await this.webhooks.rotate(access, id, requestMeta(req)));
  }

  @Post(`${W}/:endpointId/test`)
  @HttpCode(200)
  @RequirePermission('organisation.webhook.manage')
  @ApiOperation({ summary: 'Send a webhook.test event to the endpoint.' })
  async test(
    @CurrentAccess() access: OrganisationAccess,
    @Param('endpointId', uuid) id: string,
    @Req() req: Request,
  ): Promise<WebhookEndpointDetailDto> {
    const r = await this.webhooks.test(access, id, requestMeta(req));
    return { endpoint: toEndpoint(r.endpoint), deliveries: r.deliveries.map(toDelivery) };
  }
}

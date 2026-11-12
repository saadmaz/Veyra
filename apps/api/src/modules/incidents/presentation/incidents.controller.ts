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
  EscalationContactDto,
  IncidentAssigneeDto,
  IncidentDetailDto,
  IncidentDto,
} from '@veyra/api-contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import type { EscalationContactRecord, IncidentRecord } from '../application/incident-ports';
import { type IncidentDetail, IncidentsService } from '../application/incidents.service';
import {
  type ActionInput,
  actionSchema,
  type ContactInput,
  contactSchema,
  INCIDENT_CATEGORIES,
  type MoveIncidentInput,
  moveIncidentSchema,
  noteSchema,
  type ReportIncidentInput,
  reportIncidentSchema,
  type UpdateContactInput,
  type UpdateIncidentInput,
  updateContactSchema,
  updateIncidentSchema,
} from '../domain/incident-rules';

const uuid = new ParseUUIDPipe();
const I = 'properties/:propertyId/incidents';
const C = 'properties/:propertyId/escalation-contacts';
const listQuerySchema = z.object({ status: z.enum(['open', 'all']).default('open') });
const contactQuerySchema = z.object({ category: z.enum(INCIDENT_CATEGORIES).optional() });

const toIncident = (i: IncidentRecord): IncidentDto => ({
  id: i.id,
  reference: `IN-${String(i.number).padStart(6, '0')}`,
  category: i.category,
  severity: i.severity,
  title: i.title,
  description: i.description,
  occurredAt: i.occurredAt.toISOString(),
  unit: i.unit,
  commonArea: i.commonArea,
  locationDetail: i.locationDetail,
  sensitive: i.sensitive,
  status: i.status,
  outcome: i.outcome,
  reportedBy: i.reportedByName,
  resolvedAt: i.resolvedAt?.toISOString() ?? null,
  closedAt: i.closedAt?.toISOString() ?? null,
  createdAt: i.createdAt.toISOString(),
  openActions: i.openActions,
});

const toContact = (c: EscalationContactRecord): EscalationContactDto => ({ ...c });

const toDetail = (d: IncidentDetail): IncidentDetailDto => ({
  incident: toIncident(d.incident),
  updates: d.updates.map((u) => ({
    id: u.id,
    kind: u.kind,
    fromStatus: u.fromStatus,
    toStatus: u.toStatus,
    body: u.body,
    actor: u.actorName,
    createdAt: u.createdAt.toISOString(),
  })),
  actions: d.actions.map((a) => ({
    id: a.id,
    description: a.description,
    assignedTo:
      a.assignedToUserId && a.assignedToName
        ? { userId: a.assignedToUserId, name: a.assignedToName }
        : null,
    dueOn: a.dueOn,
    doneAt: a.doneAt?.toISOString() ?? null,
    doneBy: a.doneByName,
    createdAt: a.createdAt.toISOString(),
  })),
  contacts: d.contacts.map(toContact),
});

/** A property's incidents and whom to call. */
@ApiTags('incidents')
@Controller('organisations/:organisationId')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get(I)
  @RequirePermission('property.incident.read')
  @ApiOperation({ summary: 'Incidents, newest first (open ones unless status=all).' })
  async list(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
    @Req() req: Request,
  ): Promise<{ data: IncidentDto[] }> {
    const rows = await this.incidents.list(access, query.status === 'open', requestMeta(req));
    return { data: rows.map(toIncident) };
  }

  @Post(I)
  @RequirePermission('property.incident.report')
  @ApiOperation({ summary: 'Report an incident (high and critical ones alert the managers).' })
  async report(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(reportIncidentSchema)) body: ReportIncidentInput,
    @Req() req: Request,
  ): Promise<IncidentDetailDto> {
    return toDetail(await this.incidents.report(access, body, requestMeta(req)));
  }

  @Get(`${I}/assignees`)
  @RequirePermission('property.incident.manage')
  @ApiOperation({ summary: 'People who can be given a follow-up action.' })
  async assignees(
    @CurrentAccess() access: OrganisationAccess,
  ): Promise<{ data: IncidentAssigneeDto[] }> {
    const rows = await this.incidents.assignees(access);
    return { data: rows.map((r) => ({ userId: r.userId, name: r.displayName })) };
  }

  @Get(`${I}/:incidentId`)
  @RequirePermission('property.incident.read')
  @ApiOperation({ summary: 'An incident with its timeline, follow-up actions and whom to call.' })
  async get(
    @CurrentAccess() access: OrganisationAccess,
    @Param('incidentId', uuid) id: string,
    @Req() req: Request,
  ): Promise<IncidentDetailDto> {
    return toDetail(await this.incidents.detail(access, id, requestMeta(req)));
  }

  @Patch(`${I}/:incidentId`)
  @RequirePermission('property.incident.manage')
  @ApiOperation({ summary: 'Change the category, severity or sensitivity.' })
  async update(
    @CurrentAccess() access: OrganisationAccess,
    @Param('incidentId', uuid) id: string,
    @Body(new ZodValidationPipe(updateIncidentSchema)) body: UpdateIncidentInput,
    @Req() req: Request,
  ): Promise<IncidentDetailDto> {
    return toDetail(await this.incidents.update(access, id, body, requestMeta(req)));
  }

  @Post(`${I}/:incidentId/status`)
  @HttpCode(200)
  @RequirePermission('property.incident.manage')
  @ApiOperation({ summary: 'Respond, resolve (with the outcome), reopen or close.' })
  async move(
    @CurrentAccess() access: OrganisationAccess,
    @Param('incidentId', uuid) id: string,
    @Body(new ZodValidationPipe(moveIncidentSchema)) body: MoveIncidentInput,
    @Req() req: Request,
  ): Promise<IncidentDetailDto> {
    return toDetail(await this.incidents.move(access, id, body, requestMeta(req)));
  }

  @Post(`${I}/:incidentId/notes`)
  @HttpCode(200)
  @RequirePermission('property.incident.report')
  @ApiOperation({ summary: 'Add a note to the timeline.' })
  async note(
    @CurrentAccess() access: OrganisationAccess,
    @Param('incidentId', uuid) id: string,
    @Body(new ZodValidationPipe(noteSchema)) body: { body: string },
    @Req() req: Request,
  ): Promise<IncidentDetailDto> {
    return toDetail(await this.incidents.addNote(access, id, body.body, requestMeta(req)));
  }

  @Post(`${I}/:incidentId/actions`)
  @RequirePermission('property.incident.manage')
  @ApiOperation({ summary: 'Add a follow-up action (all must be done before closing).' })
  async addAction(
    @CurrentAccess() access: OrganisationAccess,
    @Param('incidentId', uuid) id: string,
    @Body(new ZodValidationPipe(actionSchema)) body: ActionInput,
    @Req() req: Request,
  ): Promise<IncidentDetailDto> {
    return toDetail(await this.incidents.addAction(access, id, body, requestMeta(req)));
  }

  @Post(`${I}/:incidentId/actions/:actionId/done`)
  @HttpCode(200)
  @RequirePermission('property.incident.read')
  @ApiOperation({ summary: 'Mark a follow-up action done (managers, or the person given it).' })
  async done(
    @CurrentAccess() access: OrganisationAccess,
    @Param('incidentId', uuid) id: string,
    @Param('actionId', uuid) actionId: string,
    @Req() req: Request,
  ): Promise<IncidentDetailDto> {
    return toDetail(await this.incidents.completeAction(access, id, actionId, requestMeta(req)));
  }

  @Get(C)
  @RequirePermission('property.incident.read')
  @ApiOperation({ summary: 'Whom to call, in order (for one kind of incident if given).' })
  async contacts(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(contactQuerySchema)) query: z.infer<typeof contactQuerySchema>,
    @Req() req: Request,
  ): Promise<{ data: EscalationContactDto[] }> {
    const rows = await this.incidents.contacts(access, query.category, requestMeta(req));
    return { data: rows.map(toContact) };
  }

  @Post(C)
  @RequirePermission('property.incident.manage')
  @ApiOperation({ summary: 'Add an escalation contact.' })
  async addContact(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(contactSchema)) body: ContactInput,
    @Req() req: Request,
  ): Promise<EscalationContactDto> {
    return toContact(await this.incidents.addContact(access, body, requestMeta(req)));
  }

  @Patch(`${C}/:contactId`)
  @RequirePermission('property.incident.manage')
  @ApiOperation({ summary: 'Change or retire an escalation contact.' })
  async updateContact(
    @CurrentAccess() access: OrganisationAccess,
    @Param('contactId', uuid) id: string,
    @Body(new ZodValidationPipe(updateContactSchema)) body: UpdateContactInput,
    @Req() req: Request,
  ): Promise<EscalationContactDto> {
    return toContact(await this.incidents.updateContact(access, id, body, requestMeta(req)));
  }
}

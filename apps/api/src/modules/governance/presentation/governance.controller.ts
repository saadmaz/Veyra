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
import type { CommitteeCandidateDto, CommitteeDto, MeetingDto } from '@veyra/api-contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import { GovernanceService } from '../application/governance.service';
import type { CommitteeRecord, MeetingRecord } from '../application/governance-ports';
import {
  type AgendaItemInput,
  agendaItemSchema,
  type CommitteeInput,
  cancelSchema,
  committeeSchema,
  endSeatSchema,
  type MeetingInput,
  meetingSchema,
  minutesSchema,
  type ResolutionInput,
  resolutionSchema,
  type SeatInput,
  seatCurrent,
  seatSchema,
  type UpdateMeetingInput,
  updateCommitteeSchema,
  updateMeetingSchema,
} from '../domain/governance-rules';

const uuid = new ParseUUIDPipe();
const C = 'properties/:propertyId/committees';
const M = 'properties/:propertyId/meetings';
const meetingsQuerySchema = z.object({ committeeId: z.uuid().optional() });

const toCommittee = (c: CommitteeRecord, today: string): CommitteeDto => ({
  id: c.id,
  name: c.name,
  purpose: c.purpose,
  status: c.status,
  dissolvedAt: c.dissolvedAt?.toISOString() ?? null,
  createdAt: c.createdAt.toISOString(),
  seats: c.seats.map((s) => ({ ...s, current: seatCurrent(s, today) })),
});

const view = (v: { committee: CommitteeRecord; today: string }) =>
  toCommittee(v.committee, v.today);

const toMeeting = (m: MeetingRecord): MeetingDto => ({
  id: m.id,
  committee: m.committee,
  title: m.title,
  scheduledAt: m.scheduledAt.toISOString(),
  location: m.location,
  status: m.status,
  heldAt: m.heldAt?.toISOString() ?? null,
  cancelReason: m.cancelReason,
  minutes: m.minutes,
  minutesApprovedAt: m.minutesApprovedAt?.toISOString() ?? null,
  minutesApprovedBy: m.minutesApprovedBy,
  agenda: m.agenda,
  resolutions: m.resolutions.map((r) => ({
    id: r.id,
    reference: `RES-${String(r.number).padStart(6, '0')}`,
    title: r.title,
    text: r.text,
    outcome: r.outcome,
    votesFor: r.votesFor,
    votesAgainst: r.votesAgainst,
    abstentions: r.abstentions,
    document: r.document,
    recordedBy: r.recordedBy,
    createdAt: r.createdAt.toISOString(),
  })),
});

/** A property's committees, meetings, minutes and resolutions. */
@ApiTags('governance')
@Controller('organisations/:organisationId')
export class GovernanceController {
  constructor(private readonly governance: GovernanceService) {}

  @Get(C)
  @RequirePermission('property.governance.read')
  @ApiOperation({ summary: 'Committees with their seats (newest term first).' })
  async committees(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: CommitteeDto[] }> {
    const { committees, today } = await this.governance.committees(access, requestMeta(req));
    return { data: committees.map((c) => toCommittee(c, today)) };
  }

  @Post(C)
  @RequirePermission('property.governance.manage')
  @ApiOperation({ summary: 'Form a committee.' })
  async createCommittee(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(committeeSchema)) body: CommitteeInput,
    @Req() req: Request,
  ): Promise<CommitteeDto> {
    return view(await this.governance.createCommittee(access, body, requestMeta(req)));
  }

  @Get(`${C}/candidates`)
  @RequirePermission('property.governance.manage')
  @ApiOperation({
    summary: 'People who can be given a seat (those with the Committee member role).',
  })
  async candidates(
    @CurrentAccess() access: OrganisationAccess,
  ): Promise<{ data: CommitteeCandidateDto[] }> {
    const rows = await this.governance.candidates(access);
    return { data: rows.map((r) => ({ userId: r.userId, name: r.displayName })) };
  }

  @Get(`${C}/:committeeId`)
  @RequirePermission('property.governance.read')
  @ApiOperation({ summary: 'A committee with its seats.' })
  async committee(
    @CurrentAccess() access: OrganisationAccess,
    @Param('committeeId', uuid) id: string,
    @Req() req: Request,
  ): Promise<CommitteeDto> {
    return view(await this.governance.committee(access, id, requestMeta(req)));
  }

  @Patch(`${C}/:committeeId`)
  @RequirePermission('property.governance.manage')
  @ApiOperation({ summary: 'Rename a committee or change its purpose.' })
  async updateCommittee(
    @CurrentAccess() access: OrganisationAccess,
    @Param('committeeId', uuid) id: string,
    @Body(new ZodValidationPipe(updateCommitteeSchema)) body: Partial<CommitteeInput>,
    @Req() req: Request,
  ): Promise<CommitteeDto> {
    return view(await this.governance.updateCommittee(access, id, body, requestMeta(req)));
  }

  @Post(`${C}/:committeeId/dissolve`)
  @HttpCode(200)
  @RequirePermission('property.governance.manage')
  @ApiOperation({ summary: 'Dissolve a committee for good (its records stay).' })
  async dissolve(
    @CurrentAccess() access: OrganisationAccess,
    @Param('committeeId', uuid) id: string,
    @Req() req: Request,
  ): Promise<CommitteeDto> {
    return view(await this.governance.dissolve(access, id, requestMeta(req)));
  }

  @Post(`${C}/:committeeId/seats`)
  @RequirePermission('property.governance.manage')
  @ApiOperation({ summary: 'Give someone a seat for a term (one at a time; one chair at a time).' })
  async addSeat(
    @CurrentAccess() access: OrganisationAccess,
    @Param('committeeId', uuid) id: string,
    @Body(new ZodValidationPipe(seatSchema)) body: SeatInput,
    @Req() req: Request,
  ): Promise<CommitteeDto> {
    return view(await this.governance.addSeat(access, id, body, requestMeta(req)));
  }

  @Post(`${C}/:committeeId/seats/:seatId/end`)
  @HttpCode(200)
  @RequirePermission('property.governance.manage')
  @ApiOperation({ summary: 'End a term on a given last day (once).' })
  async endSeat(
    @CurrentAccess() access: OrganisationAccess,
    @Param('committeeId', uuid) id: string,
    @Param('seatId', uuid) seatId: string,
    @Body(new ZodValidationPipe(endSeatSchema)) body: { termEnd: string },
    @Req() req: Request,
  ): Promise<CommitteeDto> {
    return view(await this.governance.endSeat(access, id, seatId, body.termEnd, requestMeta(req)));
  }

  @Post(`${C}/:committeeId/meetings`)
  @RequirePermission('property.governance.manage')
  @ApiOperation({ summary: 'Schedule a meeting with its agenda.' })
  async schedule(
    @CurrentAccess() access: OrganisationAccess,
    @Param('committeeId', uuid) id: string,
    @Body(new ZodValidationPipe(meetingSchema)) body: MeetingInput,
    @Req() req: Request,
  ): Promise<MeetingDto> {
    return toMeeting(await this.governance.scheduleMeeting(access, id, body, requestMeta(req)));
  }

  @Get(M)
  @RequirePermission('property.governance.read')
  @ApiOperation({ summary: 'Meetings, latest first (of one committee if given; at most 200).' })
  async meetings(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(meetingsQuerySchema)) query: z.infer<typeof meetingsQuerySchema>,
    @Req() req: Request,
  ): Promise<{ data: MeetingDto[] }> {
    const rows = await this.governance.meetings(access, query.committeeId, requestMeta(req));
    return { data: rows.map(toMeeting) };
  }

  @Get(`${M}/:meetingId`)
  @RequirePermission('property.governance.read')
  @ApiOperation({ summary: 'A meeting with its agenda, minutes and resolutions.' })
  async meeting(
    @CurrentAccess() access: OrganisationAccess,
    @Param('meetingId', uuid) id: string,
    @Req() req: Request,
  ): Promise<MeetingDto> {
    return toMeeting(await this.governance.meeting(access, id, requestMeta(req)));
  }

  @Patch(`${M}/:meetingId`)
  @RequirePermission('property.governance.manage')
  @ApiOperation({ summary: 'Change a scheduled meeting.' })
  async updateMeeting(
    @CurrentAccess() access: OrganisationAccess,
    @Param('meetingId', uuid) id: string,
    @Body(new ZodValidationPipe(updateMeetingSchema)) body: UpdateMeetingInput,
    @Req() req: Request,
  ): Promise<MeetingDto> {
    return toMeeting(await this.governance.updateMeeting(access, id, body, requestMeta(req)));
  }

  @Post(`${M}/:meetingId/agenda`)
  @HttpCode(200)
  @RequirePermission('property.governance.manage')
  @ApiOperation({ summary: 'Add an agenda item to a scheduled meeting.' })
  async agenda(
    @CurrentAccess() access: OrganisationAccess,
    @Param('meetingId', uuid) id: string,
    @Body(new ZodValidationPipe(agendaItemSchema)) body: AgendaItemInput,
    @Req() req: Request,
  ): Promise<MeetingDto> {
    return toMeeting(await this.governance.addAgendaItem(access, id, body, requestMeta(req)));
  }

  @Post(`${M}/:meetingId/held`)
  @HttpCode(200)
  @RequirePermission('property.governance.manage')
  @ApiOperation({ summary: 'Record that the meeting took place.' })
  async held(
    @CurrentAccess() access: OrganisationAccess,
    @Param('meetingId', uuid) id: string,
    @Req() req: Request,
  ): Promise<MeetingDto> {
    return toMeeting(await this.governance.hold(access, id, requestMeta(req)));
  }

  @Post(`${M}/:meetingId/cancel`)
  @HttpCode(200)
  @RequirePermission('property.governance.manage')
  @ApiOperation({ summary: 'Cancel a scheduled meeting with a reason.' })
  async cancel(
    @CurrentAccess() access: OrganisationAccess,
    @Param('meetingId', uuid) id: string,
    @Body(new ZodValidationPipe(cancelSchema)) body: { reason: string },
    @Req() req: Request,
  ): Promise<MeetingDto> {
    return toMeeting(await this.governance.cancel(access, id, body.reason, requestMeta(req)));
  }

  @Post(`${M}/:meetingId/minutes`)
  @HttpCode(200)
  @RequirePermission('property.governance.manage')
  @ApiOperation({ summary: 'Write or replace the minutes of a held meeting (until approved).' })
  async minutes(
    @CurrentAccess() access: OrganisationAccess,
    @Param('meetingId', uuid) id: string,
    @Body(new ZodValidationPipe(minutesSchema)) body: { minutes: string },
    @Req() req: Request,
  ): Promise<MeetingDto> {
    return toMeeting(
      await this.governance.writeMinutes(access, id, body.minutes, requestMeta(req)),
    );
  }

  @Post(`${M}/:meetingId/minutes/approve`)
  @HttpCode(200)
  @RequirePermission('property.governance.manage')
  @ApiOperation({ summary: 'Approve the minutes; the meeting record is then final.' })
  async approve(
    @CurrentAccess() access: OrganisationAccess,
    @Param('meetingId', uuid) id: string,
    @Req() req: Request,
  ): Promise<MeetingDto> {
    return toMeeting(await this.governance.approveMinutes(access, id, requestMeta(req)));
  }

  @Post(`${M}/:meetingId/resolutions`)
  @RequirePermission('property.governance.manage')
  @ApiOperation({ summary: 'Record a resolution taken at a held meeting (never changes).' })
  async resolution(
    @CurrentAccess() access: OrganisationAccess,
    @Param('meetingId', uuid) id: string,
    @Body(new ZodValidationPipe(resolutionSchema)) body: ResolutionInput,
    @Req() req: Request,
  ): Promise<MeetingDto> {
    return toMeeting(await this.governance.addResolution(access, id, body, requestMeta(req)));
  }
}

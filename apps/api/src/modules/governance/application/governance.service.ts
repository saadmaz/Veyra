import { Inject, Injectable } from '@nestjs/common';
import { databaseErrorCode } from '@veyra/db';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import { AccessControlService, type OrganisationAccess } from '../../access-control';
import {
  type AgendaItemInput,
  type CommitteeInput,
  type MeetingInput,
  meetingAllows,
  type ResolutionInput,
  type SeatInput,
  type UpdateMeetingInput,
} from '../domain/governance-rules';
import {
  GOVERNANCE_REPOSITORY,
  type GovernanceRepository,
  type GovernanceUnitOfWork,
  type MeetingRecord,
} from './governance-ports';

const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);
const invalidState = (message: string) => new ApiError(409, 'INVALID_STATE_TRANSITION', message);
const dissolved = () => invalidState('This committee is dissolved');

type MeetingAction = Parameters<typeof meetingAllows>[1];
const REFUSED: Record<MeetingAction, string> = {
  edit: 'Only a scheduled meeting can be changed',
  agenda: 'The agenda is fixed once the meeting is held or cancelled',
  hold: 'Only a scheduled meeting can be held',
  cancel: 'Only a scheduled meeting can be cancelled',
  minutes: 'Minutes are written for a held meeting, until they are approved',
  resolution: 'Resolutions are recorded at a held meeting, before its minutes are approved',
  approve: 'Only the minutes of a held meeting can be approved, once',
};

/**
 * Governance (Phase 11 Part 2). Managers (property.governance.manage) keep a property's
 * committees and seats, schedule meetings with an agenda, hold or cancel them, write and approve
 * the minutes, and record the resolutions with their vote counts and a supporting document.
 * Committee members (property.governance.read) read all of it. Seats go only to people who can
 * read governance at the property (normally given the Committee member role).
 */
@Injectable()
export class GovernanceService {
  constructor(
    @Inject(GOVERNANCE_REPOSITORY) private readonly repository: GovernanceRepository,
    private readonly accessControl: AccessControlService,
  ) {}

  committees(access: OrganisationAccess, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => ({
      committees: await uow.committees(),
      today: await uow.today(),
    }));
  }

  committee(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, (uow) => this.loadCommittee(uow, id));
  }

  createCommittee(access: OrganisationAccess, input: CommitteeInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const id = await uow.createCommittee({ name: input.name, purpose: input.purpose ?? null });
      await uow.audit({ action: 'committee.created', resourceType: 'committee', resourceId: id });
      return this.loadCommittee(uow, id);
    });
  }

  updateCommittee(
    access: OrganisationAccess,
    id: string,
    patch: Partial<CommitteeInput>,
    meta: RequestMeta,
  ) {
    return this.run(access, meta, async (uow) => {
      await this.activeCommittee(uow, id);
      await uow.updateCommittee(id, patch);
      await uow.audit({ action: 'committee.updated', resourceType: 'committee', resourceId: id });
      return this.loadCommittee(uow, id);
    });
  }

  dissolve(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      await this.activeCommittee(uow, id);
      const open = await uow.meetings({ committeeId: id });
      if (open.some((m) => m.status === 'SCHEDULED')) {
        throw invalidState('Hold or cancel the scheduled meetings first');
      }
      await uow.updateCommittee(id, { status: 'DISSOLVED' });
      await uow.audit({ action: 'committee.dissolved', resourceType: 'committee', resourceId: id });
      return this.loadCommittee(uow, id);
    });
  }

  /** People who can be given a seat: those who can read governance at the property. */
  candidates(access: OrganisationAccess) {
    return this.accessControl.usersWithPropertyPermission(
      access.organisationId,
      this.propertyOf(access),
      'property.governance.read',
    );
  }

  async addSeat(access: OrganisationAccess, id: string, input: SeatInput, meta: RequestMeta) {
    const allowed = await this.accessControl.holdsPropertyPermission(
      input.userId,
      access.organisationId,
      this.propertyOf(access),
      'property.governance.read',
    );
    if (!allowed) {
      throw new ApiError(
        422,
        'MEMBER_NOT_ALLOWED',
        'Give this person the Committee member role at the property first',
      );
    }
    return this.run(access, meta, async (uow) => {
      await this.activeCommittee(uow, id);
      const seatId = await uow.addSeat({
        committeeId: id,
        userId: input.userId,
        position: input.position,
        termStart: input.termStart,
        termEnd: input.termEnd ?? null,
      });
      await uow.audit({
        action: 'committee.seat_added',
        resourceType: 'committee',
        resourceId: id,
        metadata: { seatId, position: input.position },
      });
      return this.loadCommittee(uow, id);
    });
  }

  endSeat(
    access: OrganisationAccess,
    id: string,
    seatId: string,
    termEnd: string,
    meta: RequestMeta,
  ) {
    return this.run(access, meta, async (uow) => {
      const committee = await this.findCommittee(uow, id);
      const seat = committee.seats.find((s) => s.id === seatId);
      if (!seat) throw notFound('Seat');
      if (seat.termEnd !== null) throw invalidState('This term already has an end');
      if (termEnd < seat.termStart) throw invalidState('The term cannot end before it starts');
      await uow.endSeat(seatId, termEnd);
      await uow.audit({
        action: 'committee.seat_ended',
        resourceType: 'committee',
        resourceId: id,
        metadata: { seatId },
      });
      return this.loadCommittee(uow, id);
    });
  }

  meetings(access: OrganisationAccess, committeeId: string | undefined, meta: RequestMeta) {
    return this.run(access, meta, (uow) => uow.meetings(committeeId ? { committeeId } : {}));
  }

  meeting(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, (uow) => this.loadMeeting(uow, id));
  }

  scheduleMeeting(
    access: OrganisationAccess,
    committeeId: string,
    input: MeetingInput,
    meta: RequestMeta,
  ) {
    return this.run(access, meta, async (uow) => {
      await this.activeCommittee(uow, committeeId);
      const id = await uow.createMeeting({
        committeeId,
        title: input.title,
        scheduledAt: new Date(input.scheduledAt),
        location: input.location ?? null,
        agenda: input.agenda,
      });
      await uow.audit({ action: 'meeting.scheduled', resourceType: 'meeting', resourceId: id });
      return this.loadMeeting(uow, id);
    });
  }

  updateMeeting(
    access: OrganisationAccess,
    id: string,
    patch: UpdateMeetingInput,
    meta: RequestMeta,
  ) {
    return this.change(access, id, 'edit', meta, (uow) =>
      uow.updateMeeting(id, {
        ...(patch.title ? { title: patch.title } : {}),
        ...(patch.scheduledAt ? { scheduledAt: new Date(patch.scheduledAt) } : {}),
        ...(patch.location !== undefined ? { location: patch.location } : {}),
      }),
    );
  }

  addAgendaItem(access: OrganisationAccess, id: string, item: AgendaItemInput, meta: RequestMeta) {
    return this.change(access, id, 'agenda', meta, (uow) => uow.addAgendaItem(id, item));
  }

  hold(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.change(access, id, 'hold', meta, async (uow, meeting) => {
      if (meeting.scheduledAt.getTime() > Date.now() + 3_600_000) {
        throw invalidState('A meeting cannot be held before its time');
      }
      await uow.updateMeeting(id, { status: 'HELD' });
    });
  }

  cancel(access: OrganisationAccess, id: string, reason: string, meta: RequestMeta) {
    return this.change(access, id, 'cancel', meta, (uow) =>
      uow.updateMeeting(id, { status: 'CANCELLED', cancelReason: reason }),
    );
  }

  writeMinutes(access: OrganisationAccess, id: string, minutes: string, meta: RequestMeta) {
    return this.change(access, id, 'minutes', meta, (uow) => uow.updateMeeting(id, { minutes }));
  }

  approveMinutes(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.change(access, id, 'approve', meta, async (uow, meeting) => {
      if (!meeting.minutes) throw invalidState('Write the minutes before approving them');
      await uow.updateMeeting(id, { approveMinutes: true });
    });
  }

  addResolution(access: OrganisationAccess, id: string, input: ResolutionInput, meta: RequestMeta) {
    return this.change(access, id, 'resolution', meta, (uow) => uow.addResolution(id, input));
  }

  private change(
    access: OrganisationAccess,
    id: string,
    what: MeetingAction,
    meta: RequestMeta,
    work: (uow: GovernanceUnitOfWork, meeting: MeetingRecord) => Promise<unknown>,
  ) {
    return this.run(access, meta, async (uow) => {
      const meeting = await this.loadMeeting(uow, id);
      if (
        !meetingAllows(
          { status: meeting.status, minutesApproved: Boolean(meeting.minutesApprovedAt) },
          what,
        )
      ) {
        throw invalidState(REFUSED[what]);
      }
      await work(uow, meeting);
      await uow.audit({ action: `meeting.${what}`, resourceType: 'meeting', resourceId: id });
      return this.loadMeeting(uow, id);
    });
  }

  /** A committee with the property's local date, to tell current seats. */
  private async loadCommittee(uow: GovernanceUnitOfWork, id: string) {
    return { committee: await this.findCommittee(uow, id), today: await uow.today() };
  }

  private async findCommittee(uow: GovernanceUnitOfWork, id: string) {
    const committee = await uow.committee(id);
    if (!committee) throw notFound('Committee');
    return committee;
  }

  private async activeCommittee(uow: GovernanceUnitOfWork, id: string) {
    const committee = await this.findCommittee(uow, id);
    if (committee.status !== 'ACTIVE') throw dissolved();
    return committee;
  }

  private async loadMeeting(uow: GovernanceUnitOfWork, id: string) {
    const meeting = await uow.meeting(id);
    if (!meeting) throw notFound('Meeting');
    return meeting;
  }

  private propertyOf(access: OrganisationAccess) {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    return access.propertyId;
  }

  private async run<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: GovernanceUnitOfWork) => Promise<T>,
  ) {
    try {
      return await this.repository.inProperty(
        access.organisationId,
        this.propertyOf(access),
        access.userId,
        meta,
        work,
      );
    } catch (error) {
      const code = databaseErrorCode(error);
      if (code === '23P01') {
        throw new ApiError(
          409,
          'SEAT_OVERLAPS',
          'This person already has a seat then, or the committee already has a chair then',
        );
      }
      if (code === '23505') {
        throw new ApiError(
          409,
          'NAME_TAKEN',
          'An active committee or agenda item already uses this',
        );
      }
      if (code === '23503') {
        throw new ApiError(422, 'UNKNOWN_DOCUMENT', 'That document is not at this property');
      }
      if (code === '23514')
        throw invalidState('This change is not possible. Reload and try again.');
      throw error;
    }
  }
}

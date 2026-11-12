import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, type DbTransaction, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import type {
  CommitteeRecord,
  GovernanceRepository,
  GovernanceUnitOfWork,
  MeetingRecord,
} from '../application/governance-ports';
import type { AgendaItemInput, ResolutionInput } from '../domain/governance-rules';

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const asDate = (d: string) => new Date(`${d}T00:00:00Z`);

const COMMITTEE = {
  id: true,
  name: true,
  purpose: true,
  status: true,
  dissolvedAt: true,
  createdAt: true,
  members: {
    select: {
      id: true,
      userId: true,
      position: true,
      termStart: true,
      termEnd: true,
      user: { select: { displayName: true } },
    },
    orderBy: { termStart: 'desc' as const },
  },
} as const;

const MEETING = {
  id: true,
  committee: { select: { id: true, name: true } },
  title: true,
  scheduledAt: true,
  location: true,
  status: true,
  heldAt: true,
  cancelReason: true,
  minutes: true,
  minutesApprovedAt: true,
  minutesApprovedBy: { select: { displayName: true } },
  agendaItems: {
    select: { id: true, position: true, title: true, details: true },
    orderBy: { position: 'asc' as const },
  },
  resolutions: {
    select: {
      id: true,
      resolutionNumber: true,
      title: true,
      text: true,
      outcome: true,
      votesFor: true,
      votesAgainst: true,
      abstentions: true,
      document: { select: { id: true, title: true } },
      recordedBy: { select: { displayName: true } },
      createdAt: true,
    },
    orderBy: { resolutionNumber: 'asc' as const },
  },
} as const;

type CommitteeRow = Omit<CommitteeRecord, 'seats'> & {
  members: {
    id: string;
    userId: string;
    position: CommitteeRecord['seats'][number]['position'];
    termStart: Date;
    termEnd: Date | null;
    user: { displayName: string };
  }[];
};

const toCommittee = ({ members, ...row }: CommitteeRow): CommitteeRecord => ({
  ...row,
  seats: members.map((m) => ({
    id: m.id,
    userId: m.userId,
    name: m.user.displayName,
    position: m.position,
    termStart: day(m.termStart) as string,
    termEnd: day(m.termEnd),
  })),
});

type MeetingRow = Omit<MeetingRecord, 'minutesApprovedBy' | 'agenda' | 'resolutions'> & {
  minutesApprovedBy: { displayName: string } | null;
  agendaItems: MeetingRecord['agenda'];
  resolutions: (Omit<MeetingRecord['resolutions'][number], 'number' | 'recordedBy'> & {
    resolutionNumber: bigint | null;
    recordedBy: { displayName: string };
  })[];
};

const toMeeting = ({
  minutesApprovedBy,
  agendaItems,
  resolutions,
  ...row
}: MeetingRow): MeetingRecord => ({
  ...row,
  minutesApprovedBy: minutesApprovedBy?.displayName ?? null,
  agenda: agendaItems,
  resolutions: resolutions.map(({ resolutionNumber, recordedBy, ...r }) => ({
    ...r,
    number: Number(resolutionNumber ?? 0),
    recordedBy: recordedBy.displayName,
  })),
});

class PrismaGovernanceUnitOfWork implements GovernanceUnitOfWork {
  private readonly scope: { organisationId: string; propertyId: string };

  constructor(
    private readonly tx: DbTransaction,
    private readonly organisationId: string,
    private readonly propertyId: string,
    private readonly userId: string,
    private readonly meta: RequestMeta,
  ) {
    this.scope = { organisationId, propertyId };
  }

  async today() {
    const rows = await this.tx.$queryRaw<{ today: string }[]>`
      SELECT to_char((now() AT TIME ZONE "time_zone")::date, 'YYYY-MM-DD') AS today
        FROM "properties" WHERE "id" = ${this.propertyId}::uuid AND "organisation_id" = ${this.organisationId}::uuid`;
    const today = rows[0]?.today;
    if (!today) throw new Error('Property vanished inside its own transaction');
    return today;
  }

  async committees() {
    const rows = await this.tx.committee.findMany({
      where: this.scope,
      select: COMMITTEE,
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
    return (rows as CommitteeRow[]).map(toCommittee);
  }

  async committee(id: string) {
    const row = await this.tx.committee.findFirst({
      where: { ...this.scope, id },
      select: COMMITTEE,
    });
    return row ? toCommittee(row as CommitteeRow) : null;
  }

  async createCommittee(input: { name: string; purpose: string | null }) {
    const row = await this.tx.committee.create({
      data: { ...this.scope, ...input },
      select: { id: true },
    });
    return row.id;
  }

  async updateCommittee(
    id: string,
    patch: { name?: string; purpose?: string | null; status?: 'DISSOLVED' },
  ) {
    await this.tx.committee.updateMany({ where: { ...this.scope, id }, data: patch });
  }

  async addSeat(input: Parameters<GovernanceUnitOfWork['addSeat']>[0]) {
    const row = await this.tx.committeeMember.create({
      data: {
        ...this.scope,
        committeeId: input.committeeId,
        userId: input.userId,
        position: input.position,
        termStart: asDate(input.termStart),
        termEnd: input.termEnd ? asDate(input.termEnd) : null,
      },
      select: { id: true },
    });
    return row.id;
  }

  async endSeat(id: string, termEnd: string) {
    await this.tx.committeeMember.updateMany({
      where: { ...this.scope, id, termEnd: null },
      data: { termEnd: asDate(termEnd) },
    });
  }

  async meetings(filter: { committeeId?: string }) {
    const rows = await this.tx.meeting.findMany({
      where: { ...this.scope, ...(filter.committeeId ? { committeeId: filter.committeeId } : {}) },
      select: MEETING,
      orderBy: { scheduledAt: 'desc' },
      take: 200,
    });
    return (rows as MeetingRow[]).map(toMeeting);
  }

  async meeting(id: string) {
    const row = await this.tx.meeting.findFirst({ where: { ...this.scope, id }, select: MEETING });
    return row ? toMeeting(row as MeetingRow) : null;
  }

  async createMeeting(input: Parameters<GovernanceUnitOfWork['createMeeting']>[0]) {
    const { agenda, ...meeting } = input;
    const row = await this.tx.meeting.create({
      data: { ...this.scope, ...meeting },
      select: { id: true },
    });
    if (agenda.length > 0) {
      await this.tx.meetingAgendaItem.createMany({
        data: agenda.map((item, i) => ({
          ...this.scope,
          meetingId: row.id,
          position: i + 1,
          title: item.title,
          details: item.details ?? null,
        })),
      });
    }
    return row.id;
  }

  async updateMeeting(id: string, patch: Parameters<GovernanceUnitOfWork['updateMeeting']>[1]) {
    const { approveMinutes, ...rest } = patch;
    await this.tx.meeting.updateMany({
      where: { ...this.scope, id },
      // The database sets the approval time and person (app_meeting_guard).
      data: approveMinutes
        ? { ...rest, minutesApprovedAt: new Date(), minutesApprovedUserId: this.userId }
        : rest,
    });
  }

  async addAgendaItem(meetingId: string, item: AgendaItemInput) {
    const last = await this.tx.meetingAgendaItem.aggregate({
      where: { ...this.scope, meetingId },
      _max: { position: true },
    });
    await this.tx.meetingAgendaItem.create({
      data: {
        ...this.scope,
        meetingId,
        position: (last._max.position ?? 0) + 1,
        title: item.title,
        details: item.details ?? null,
      },
    });
  }

  async addResolution(meetingId: string, input: ResolutionInput) {
    const row = await this.tx.resolution.create({
      data: {
        ...this.scope,
        meetingId,
        title: input.title,
        text: input.text,
        outcome: input.outcome,
        votesFor: input.votesFor ?? null,
        votesAgainst: input.votesAgainst ?? null,
        abstentions: input.abstentions ?? null,
        documentId: input.documentId ?? null,
        recordedByUserId: this.userId,
      },
      select: { id: true },
    });
    return row.id;
  }

  async audit(event: Parameters<GovernanceUnitOfWork['audit']>[0]) {
    await this.tx.auditLog.createMany({
      data: [
        {
          organisationId: this.organisationId,
          actorUserId: this.userId,
          action: event.action,
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          metadata: { propertyId: this.propertyId, ...(event.metadata ?? {}) },
          requestId: clip(this.meta.requestId, 128),
          ipAddress: clip(this.meta.ipAddress, 64),
        },
      ],
    });
  }
}

/** Governance persistence over Prisma, always inside the organisation's RLS context. */
@Injectable()
export class PrismaGovernanceRepository implements GovernanceRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: GovernanceUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaGovernanceUnitOfWork(tx, organisationId, propertyId, userId, meta)),
      { userId },
    );
  }
}

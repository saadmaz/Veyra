import type { RequestMeta } from '../../../platform/request-meta';
import type {
  AgendaItemInput,
  CommitteePosition,
  MeetingStatus,
  ResolutionInput,
} from '../domain/governance-rules';

export interface SeatRecord {
  id: string;
  userId: string;
  name: string;
  position: CommitteePosition;
  termStart: string;
  termEnd: string | null;
}

export interface CommitteeRecord {
  id: string;
  name: string;
  purpose: string | null;
  status: 'ACTIVE' | 'DISSOLVED';
  dissolvedAt: Date | null;
  createdAt: Date;
  seats: SeatRecord[];
}

export interface MeetingRecord {
  id: string;
  committee: { id: string; name: string };
  title: string;
  scheduledAt: Date;
  location: string | null;
  status: MeetingStatus;
  heldAt: Date | null;
  cancelReason: string | null;
  minutes: string | null;
  minutesApprovedAt: Date | null;
  minutesApprovedBy: string | null;
  agenda: { id: string; position: number; title: string; details: string | null }[];
  resolutions: ResolutionRecord[];
}

export interface ResolutionRecord {
  id: string;
  number: number;
  title: string;
  text: string;
  outcome: 'PASSED' | 'REJECTED' | 'DEFERRED';
  votesFor: number | null;
  votesAgainst: number | null;
  abstentions: number | null;
  document: { id: string; title: string } | null;
  recordedBy: string;
  createdAt: Date;
}

/** One transaction in the organisation's RLS context, limited to one property. */
export interface GovernanceUnitOfWork {
  today(): Promise<string>;
  committees(): Promise<CommitteeRecord[]>;
  committee(id: string): Promise<CommitteeRecord | null>;
  createCommittee(input: { name: string; purpose: string | null }): Promise<string>;
  updateCommittee(
    id: string,
    patch: { name?: string; purpose?: string | null; status?: 'DISSOLVED' },
  ): Promise<void>;
  addSeat(input: {
    committeeId: string;
    userId: string;
    position: CommitteePosition;
    termStart: string;
    termEnd: string | null;
  }): Promise<string>;
  endSeat(id: string, termEnd: string): Promise<void>;
  meetings(filter: { committeeId?: string }): Promise<MeetingRecord[]>;
  meeting(id: string): Promise<MeetingRecord | null>;
  createMeeting(input: {
    committeeId: string;
    title: string;
    scheduledAt: Date;
    location: string | null;
    agenda: AgendaItemInput[];
  }): Promise<string>;
  updateMeeting(
    id: string,
    patch: {
      title?: string;
      scheduledAt?: Date;
      location?: string | null;
      status?: 'HELD' | 'CANCELLED';
      cancelReason?: string;
      minutes?: string;
      approveMinutes?: true;
    },
  ): Promise<void>;
  addAgendaItem(meetingId: string, item: AgendaItemInput): Promise<void>;
  addResolution(meetingId: string, input: ResolutionInput): Promise<string>;
  audit(event: {
    action: string;
    resourceType: 'committee' | 'meeting';
    resourceId: string;
    metadata?: Record<string, string | number | boolean>;
  }): Promise<void>;
}

export interface GovernanceRepository {
  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: GovernanceUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export const GOVERNANCE_REPOSITORY = Symbol('GOVERNANCE_REPOSITORY');

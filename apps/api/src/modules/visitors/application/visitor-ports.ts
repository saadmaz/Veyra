import type { RequestMeta } from '../../../platform/request-meta';
import type { CreateInvitationInput } from '../domain/visitor-rules';

export type VisitorCategory = 'GUEST' | 'DELIVERY' | 'CONTRACTOR' | 'SERVICE_PROVIDER';

export interface InvitationRecord {
  id: string;
  unitId: string;
  unitNumber: string;
  hostPersonId: string | null;
  createdByUserId: string;
  category: VisitorCategory;
  visitorName: string;
  visitorPhone: string | null;
  vehiclePlate: string | null;
  validFrom: Date;
  validUntil: Date;
  maxEntries: number;
  entriesUsed: number;
  status: 'ACTIVE' | 'REVOKED';
  revokedAt: Date | null;
  createdAt: Date;
}

export interface PassRecord {
  id: string;
  invitationId: string;
  revokedAt: Date | null;
}

export interface VisitRecord {
  id: string;
  unitId: string | null;
  unitNumber: string | null;
  invitationId: string | null;
  category: VisitorCategory;
  visitorName: string;
  vehiclePlate: string | null;
  decision: 'ADMITTED' | 'DENIED';
  denialReason: string | null;
  gate: string | null;
  arrivedAt: Date;
  departedAt: Date | null;
  source: 'ONLINE' | 'PAPER' | 'OFFLINE_SYNC';
}

export interface NewVisit {
  unitId: string | null;
  invitationId: string | null;
  passId: string | null;
  category: VisitorCategory;
  visitorName: string;
  visitorPhone: string | null;
  vehiclePlate: string | null;
  decision: 'ADMITTED' | 'DENIED';
  denialReason: string | null;
  gate: string | null;
  arrivedAt: Date;
}

export type AccessEventType =
  | 'PASS_ACCEPTED'
  | 'PASS_REJECTED'
  | 'VISIT_ADMITTED'
  | 'VISIT_DENIED'
  | 'VISIT_DEPARTED';

export interface VisitorAuditEvent {
  action: string;
  resourceId: string;
  /** Never visitor personal data. */
  metadata?: Record<string, string | number>;
}

/** Thrown when a pass's random code collides with a live one at the property (retry). */
export class PassCodeCollision extends Error {}

/**
 * One transaction in the organisation's RLS context, limited to one property. Every query filters
 * by organisation and property explicitly as well.
 */
export interface VisitorsUnitOfWork {
  /** The unit, if it belongs to this property. */
  unit(
    unitId: string,
  ): Promise<{ id: string; number: string; status: 'ACTIVE' | 'ARCHIVED' } | null>;
  /** The caller's own active resident profile in the organisation, if any. */
  myPersonId(): Promise<string | null>;
  createInvitation(
    unitId: string,
    hostPersonId: string | null,
    input: CreateInvitationInput,
  ): Promise<string>;
  /** Throws PassCodeCollision when the code hash is already live at the property. */
  createPass(invitationId: string, tokenHash: string, codeHash: string): Promise<string>;
  invitation(invitationId: string, options?: { lock?: boolean }): Promise<InvitationRecord | null>;
  unitInvitations(unitId: string, endedAfter: Date): Promise<InvitationRecord[]>;
  propertyInvitations(endedAfter: Date): Promise<InvitationRecord[]>;
  /** Revokes the invitation and its live passes. */
  revokeInvitation(invitationId: string, at: Date): Promise<void>;
  passByTokenHash(tokenHash: string): Promise<PassRecord | null>;
  passByCodeHash(codeHash: string): Promise<PassRecord | null>;
  pass(passId: string): Promise<PassRecord | null>;
  /** True when the invitation has no host, or its host still lives at its unit today. */
  hostStillResident(invitationId: string): Promise<boolean>;
  createVisit(visit: NewVisit): Promise<VisitRecord>;
  visit(visitId: string, options?: { lock?: boolean }): Promise<VisitRecord | null>;
  recordDeparture(visitId: string, at: Date): Promise<VisitRecord>;
  visitorsInside(): Promise<VisitRecord[]>;
  visitLog(from: Date, to: Date): Promise<VisitRecord[]>;
  accessEvent(
    type: AccessEventType,
    at: Date,
    links: { invitationId?: string | null; visitId?: string | null; gate?: string | null },
  ): Promise<void>;
  audit(event: VisitorAuditEvent): Promise<void>;
}

export interface VisitorsRepository {
  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: VisitorsUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export const VISITORS_REPOSITORY = Symbol('VISITORS_REPOSITORY');

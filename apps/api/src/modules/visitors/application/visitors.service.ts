import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PassRejectionReason } from '@veyra/api-contracts';
import { databaseErrorCode } from '@veyra/db';
import { CLOCK, type Clock } from '../../../platform/clock';
import { ApiError } from '../../../platform/errors/api-error';
import { RATE_LIMITER, type RateLimiter } from '../../../platform/rate-limit/rate-limiter';
import type { RequestMeta } from '../../../platform/request-meta';
import type { OrganisationAccess } from '../../access-control';
import {
  type AdmitInput,
  type CreateInvitationInput,
  type DenyInput,
  hashCode,
  hashToken,
  MAX_LEAD_MS,
  MAX_PENDING_WALK_INS_PER_UNIT,
  newPassSecret,
  type PassSecret,
  passRejection,
  type ValidatePassInput,
  WALK_IN_ANSWER_MS,
  type WalkInInput,
  type WalkInRequestInput,
  walkInAdmissionProblem,
  walkInStatus,
} from '../domain/visitor-rules';
import {
  type InvitationRecord,
  PassCodeCollision,
  type PassRecord,
  VISITORS_REPOSITORY,
  type VisitorsRepository,
  type VisitorsUnitOfWork,
  type WalkInRequestRecord,
} from './visitor-ports';

/** Pass lookups per guard: enough for a busy gate, too few to guess reference codes. */
const VALIDATE_LIMIT = { limit: 60, windowMs: 60_000 };
/** How long ended invitations stay in lists. */
const RECENT_MS = 7 * 86_400_000;
/** How far back walk-in requests are listed: the gate screen and a resident's recent answers. */
const RECENT_WALK_INS_MS = 24 * 3_600_000;

/**
 * The database backstop refused an admission the API had just allowed: a race lost to another
 * gate, or a revocation in the same instant. Reported like the API's own check.
 */
const admissionRefused = () =>
  new ApiError(409, 'PASS_NOT_VALID', 'This pass can no longer be used');

const notFound = (what: string) => new ApiError(404, 'NOT_FOUND', `${what} not found`);

export type PassCheck =
  | { valid: true; invitation: InvitationRecord; passId: string }
  | { valid: false; reason: PassRejectionReason; invitationId: string | null };

/**
 * Visitor invitations, passes and the gate (Phase 5 Part 2). The API checks every rule; the
 * database repeats the critical ones for online admissions (window, revocation, entries, live
 * pass) under a row lock, so two gates can never both use the last entry.
 */
@Injectable()
export class VisitorsService {
  private readonly logger = new Logger(VisitorsService.name);

  constructor(
    @Inject(VISITORS_REPOSITORY) private readonly repository: VisitorsRepository,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------ residents and staff (unit)

  /** Registers a visitor and returns the pass once (only its hashes are stored). */
  createInvitation(access: OrganisationAccess, input: CreateInvitationInput, meta: RequestMeta) {
    const unitId = this.unitOf(access);
    const now = this.clock.now();
    if (input.validUntil <= now) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'The visit must end in the future');
    }
    if (input.validFrom.getTime() - now.getTime() > MAX_LEAD_MS) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Visits can be registered up to 90 days ahead');
    }
    return this.inProperty(access, meta, async (uow) => {
      const unit = await uow.unit(unitId);
      if (!unit) throw notFound('Unit');
      if (unit.status === 'ARCHIVED') throw new ApiError(409, 'ARCHIVED', 'This unit is archived');
      // A resident is the host; staff registering on someone's behalf leave it empty.
      const host = await uow.myPersonId();
      const invitationId = await uow.createInvitation(unitId, host, input);
      const secret = await this.issuePass(uow, access, invitationId);
      await uow.audit({
        action: 'visitor_invitation.created',
        resourceId: invitationId,
        metadata: { unitId, category: input.category, maxEntries: input.maxEntries },
      });
      const invitation = await uow.invitation(invitationId);
      if (!invitation) throw new Error('Invitation vanished inside its own transaction');
      return { invitation, pass: secret };
    });
  }

  unitInvitations(access: OrganisationAccess, meta: RequestMeta) {
    const unitId = this.unitOf(access);
    const since = new Date(this.clock.now().getTime() - RECENT_MS);
    return this.inProperty(access, meta, (uow) => uow.unitInvitations(unitId, since));
  }

  /** Anyone who may register visitors for the unit may cancel the unit's invitations. */
  revokeUnitInvitation(access: OrganisationAccess, invitationId: string, meta: RequestMeta) {
    const unitId = this.unitOf(access);
    return this.inProperty(access, meta, async (uow) => {
      const invitation = await uow.invitation(invitationId, { lock: true });
      if (!invitation || invitation.unitId !== unitId) throw notFound('Visitor invitation');
      return this.revoke(uow, invitation);
    });
  }

  // ------------------------------------------------------------------ supervisors and staff

  propertyInvitations(access: OrganisationAccess, meta: RequestMeta) {
    const since = new Date(this.clock.now().getTime() - RECENT_MS);
    return this.inProperty(access, meta, (uow) => uow.propertyInvitations(since));
  }

  revokePropertyInvitation(access: OrganisationAccess, invitationId: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const invitation = await uow.invitation(invitationId, { lock: true });
      if (!invitation) throw notFound('Visitor invitation');
      return this.revoke(uow, invitation);
    });
  }

  visitLog(access: OrganisationAccess, from: Date, to: Date, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => uow.visitLog(from, to));
  }

  // ------------------------------------------------------------------ gate

  /**
   * A guard scans a QR code or types a reference code. The answer shows only what is needed to
   * check the person: name, category, plate, unit number and window, never contact details.
   * Every attempt is logged; lookups are rate limited per guard.
   */
  async validatePass(access: OrganisationAccess, input: ValidatePassInput, meta: RequestMeta) {
    await this.enforceValidateLimit(access.userId);
    const propertyId = this.propertyOf(access);
    return this.inProperty(access, meta, async (uow) => {
      const pass = input.token
        ? await uow.passByTokenHash(hashToken(input.token))
        : await uow.passByCodeHash(hashCode(propertyId, input.code as string));
      const check = await this.checkPass(uow, pass);
      await uow.accessEvent(check.valid ? 'PASS_ACCEPTED' : 'PASS_REJECTED', this.clock.now(), {
        invitationId: check.valid ? check.invitation.id : check.invitationId,
        gate: input.gate ?? null,
      });
      return check;
    });
  }

  /** Admits a pre-registered visitor. Re-checks the pass under a lock on its invitation. */
  admit(access: OrganisationAccess, input: AdmitInput, meta: RequestMeta) {
    return this.inProperty(
      access,
      meta,
      async (uow) => {
        const pass = await uow.pass(input.passId);
        if (!pass) throw notFound('Pass');
        await uow.invitation(pass.invitationId, { lock: true });
        const check = await this.checkPass(uow, pass);
        if (!check.valid) {
          throw new ApiError(409, 'PASS_NOT_VALID', `This pass cannot be used: ${check.reason}`);
        }
        const inv = check.invitation;
        const visit = await uow.createVisit({
          unitId: inv.unitId,
          invitationId: inv.id,
          passId: pass.id,
          category: inv.category,
          visitorName: inv.visitorName,
          visitorPhone: inv.visitorPhone,
          vehiclePlate: inv.vehiclePlate,
          decision: 'ADMITTED',
          denialReason: null,
          gate: input.gate ?? null,
          arrivedAt: this.clock.now(),
        });
        await uow.accessEvent('VISIT_ADMITTED', visit.arrivedAt, {
          invitationId: inv.id,
          visitId: visit.id,
          gate: visit.gate,
        });
        return visit;
      },
      admissionRefused,
    );
  }

  /** Records a refusal: for a pass (details from its invitation) or for someone without one. */
  deny(access: OrganisationAccess, input: DenyInput, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      let details: {
        unitId: string | null;
        invitationId: string | null;
        passId: string | null;
        category: InvitationRecord['category'];
        visitorName: string;
        vehiclePlate: string | null;
      };
      if (input.passId) {
        const pass = await uow.pass(input.passId);
        if (!pass) throw notFound('Pass');
        const inv = await uow.invitation(pass.invitationId);
        if (!inv) throw notFound('Visitor invitation');
        details = {
          unitId: inv.unitId,
          invitationId: inv.id,
          passId: pass.id,
          category: inv.category,
          visitorName: inv.visitorName,
          vehiclePlate: inv.vehiclePlate,
        };
      } else {
        if (input.unitId && !(await uow.unit(input.unitId))) throw notFound('Unit');
        details = {
          unitId: input.unitId ?? null,
          invitationId: null,
          passId: null,
          category: input.category as InvitationRecord['category'],
          visitorName: input.visitorName as string,
          vehiclePlate: input.vehiclePlate ?? null,
        };
      }
      const visit = await uow.createVisit({
        ...details,
        visitorPhone: null,
        decision: 'DENIED',
        denialReason: input.reason,
        gate: input.gate ?? null,
        arrivedAt: this.clock.now(),
      });
      await uow.accessEvent('VISIT_DENIED', visit.arrivedAt, {
        invitationId: details.invitationId,
        visitId: visit.id,
        gate: visit.gate,
      });
      return visit;
    });
  }

  /**
   * Someone without a pass. Visits to a unit need the resident's in-app approval (Part 3), so
   * they are refused until it exists: nobody enters a home on the guard's word alone. Visits to
   * the property itself (e.g. a delivery to the gate office) are admitted and recorded.
   */
  walkIn(access: OrganisationAccess, input: WalkInInput, meta: RequestMeta) {
    if (input.unitId) {
      throw new ApiError(
        409,
        'WALK_IN_NEEDS_APPROVAL',
        'A visitor without a pass needs the resident’s approval before entering a unit: send a walk-in request',
      );
    }
    return this.inProperty(access, meta, async (uow) => {
      const visit = await uow.createVisit({
        unitId: null,
        invitationId: null,
        passId: null,
        category: input.category,
        visitorName: input.visitorName,
        visitorPhone: input.visitorPhone ?? null,
        vehiclePlate: input.vehiclePlate ?? null,
        decision: 'ADMITTED',
        denialReason: null,
        gate: input.gate ?? null,
        arrivedAt: this.clock.now(),
      });
      await uow.accessEvent('VISIT_ADMITTED', visit.arrivedAt, {
        visitId: visit.id,
        gate: visit.gate,
      });
      return visit;
    });
  }

  depart(access: OrganisationAccess, visitId: string, gate: string | undefined, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const visit = await uow.visit(visitId, { lock: true });
      if (!visit) throw notFound('Visit');
      if (visit.decision !== 'ADMITTED') {
        throw new ApiError(409, 'INVALID_STATE_TRANSITION', 'This visitor was not admitted');
      }
      if (visit.departedAt) {
        throw new ApiError(409, 'VISIT_ALREADY_DEPARTED', 'This departure is already recorded');
      }
      const departed = await uow.recordDeparture(visitId, this.clock.now());
      await uow.accessEvent('VISIT_DEPARTED', departed.departedAt as Date, {
        invitationId: departed.invitationId,
        visitId,
        gate: gate ?? null,
      });
      return departed;
    });
  }

  visitorsInside(access: OrganisationAccess, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => uow.visitorsInside());
  }

  // ------------------------------------------------------------------ walk-in approval (Part 3)

  /** The guard asks the unit's residents to let someone in; they have 10 minutes to answer. */
  requestWalkIn(access: OrganisationAccess, input: WalkInRequestInput, meta: RequestMeta) {
    const now = this.clock.now();
    return this.inProperty(access, meta, async (uow) => {
      const unit = await uow.unit(input.unitId);
      if (!unit) throw notFound('Unit');
      if (unit.status === 'ARCHIVED') throw new ApiError(409, 'ARCHIVED', 'This unit is archived');
      if ((await uow.openWalkInCount(input.unitId, now)) >= MAX_PENDING_WALK_INS_PER_UNIT) {
        throw new ApiError(
          409,
          'TOO_MANY_WALK_IN_REQUESTS',
          'This unit already has several requests waiting for an answer',
        );
      }
      const id = await uow.createWalkInRequest(input, new Date(now.getTime() + WALK_IN_ANSWER_MS));
      return this.requireWalkIn(uow, id);
    });
  }

  gateWalkInRequests(access: OrganisationAccess, meta: RequestMeta) {
    const since = new Date(this.clock.now().getTime() - RECENT_WALK_INS_MS);
    return this.inProperty(access, meta, (uow) => uow.walkInRequests({ createdAfter: since }));
  }

  gateWalkInRequest(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, (uow) => this.requireWalkIn(uow, id));
  }

  cancelWalkIn(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.inProperty(access, meta, async (uow) => {
      const request = await this.requireWalkIn(uow, id, true);
      if (request.status !== 'PENDING') {
        throw new ApiError(409, 'WALK_IN_NOT_PENDING', 'This request was already answered');
      }
      await uow.decideWalkInRequest(id, 'CANCELLED', this.clock.now());
      return this.requireWalkIn(uow, id);
    });
  }

  /** Admits the visitor on a resident's approval: once, and within 15 minutes of it. */
  admitWalkIn(access: OrganisationAccess, id: string, gate: string | undefined, meta: RequestMeta) {
    return this.inProperty(
      access,
      meta,
      async (uow) => {
        const request = await this.requireWalkIn(uow, id, true);
        const problem = walkInAdmissionProblem(request, this.clock.now());
        if (problem) {
          throw new ApiError(
            409,
            'WALK_IN_NOT_APPROVED',
            `This visitor cannot be admitted: ${problem}`,
          );
        }
        const visit = await uow.createVisit({
          unitId: request.unitId,
          invitationId: null,
          passId: null,
          walkInRequestId: request.id,
          category: request.category,
          visitorName: request.visitorName,
          visitorPhone: request.visitorPhone,
          vehiclePlate: request.vehiclePlate,
          decision: 'ADMITTED',
          denialReason: null,
          gate: gate ?? request.gate,
          arrivedAt: this.clock.now(),
        });
        await uow.accessEvent('VISIT_ADMITTED', visit.arrivedAt, {
          visitId: visit.id,
          gate: visit.gate,
        });
        return visit;
      },
      () => new ApiError(409, 'WALK_IN_NOT_APPROVED', 'This approval can no longer be used'),
    );
  }

  /** Requests waiting for this unit's residents, and recent answers. */
  unitWalkInRequests(access: OrganisationAccess, meta: RequestMeta) {
    const unitId = this.unitOf(access);
    const since = new Date(this.clock.now().getTime() - RECENT_WALK_INS_MS);
    return this.inProperty(access, meta, (uow) =>
      uow.walkInRequests({ unitId, createdAfter: since }),
    );
  }

  /**
   * A resident approves or denies. Only someone who lives at the unit today may answer (owner
   * decision: the resident approves), not staff; and only before the request expires.
   */
  decideWalkIn(access: OrganisationAccess, id: string, approve: boolean, meta: RequestMeta) {
    const unitId = this.unitOf(access);
    return this.inProperty(
      access,
      meta,
      async (uow) => {
        if (!(await uow.callerIsResidentOf(unitId))) {
          throw new ApiError(
            403,
            'FORBIDDEN',
            'Only residents of the unit can answer a walk-in request',
          );
        }
        const request = await this.requireWalkIn(uow, id, true);
        if (request.unitId !== unitId) throw notFound('Walk-in request');
        const status = walkInStatus(request, this.clock.now());
        if (status === 'EXPIRED') {
          throw new ApiError(409, 'WALK_IN_EXPIRED', 'This request expired before it was answered');
        }
        if (status !== 'PENDING') {
          throw new ApiError(409, 'WALK_IN_NOT_PENDING', 'This request was already answered');
        }
        await uow.decideWalkInRequest(id, approve ? 'APPROVED' : 'DENIED', this.clock.now());
        return this.requireWalkIn(uow, id);
      },
      () => new ApiError(409, 'WALK_IN_EXPIRED', 'This request expired before it was answered'),
    );
  }

  // ------------------------------------------------------------------ helpers

  private async requireWalkIn(
    uow: VisitorsUnitOfWork,
    id: string,
    lock = false,
  ): Promise<WalkInRequestRecord> {
    const request = await uow.walkInRequest(id, { lock });
    if (!request) throw notFound('Walk-in request');
    return request;
  }

  private async checkPass(uow: VisitorsUnitOfWork, pass: PassRecord | null): Promise<PassCheck> {
    if (!pass) return { valid: false, reason: 'NOT_FOUND', invitationId: null };
    const invitation = await uow.invitation(pass.invitationId);
    if (!invitation) return { valid: false, reason: 'NOT_FOUND', invitationId: null };
    const reason = passRejection(
      {
        passRevoked: pass.revokedAt !== null,
        invitationStatus: invitation.status,
        validFrom: invitation.validFrom,
        validUntil: invitation.validUntil,
        maxEntries: invitation.maxEntries,
        entriesUsed: invitation.entriesUsed,
        hostStillResident: await uow.hostStillResident(invitation.id),
      },
      this.clock.now(),
    );
    return reason
      ? { valid: false, reason, invitationId: invitation.id }
      : { valid: true, invitation, passId: pass.id };
  }

  private async issuePass(
    uow: VisitorsUnitOfWork,
    access: OrganisationAccess,
    invitationId: string,
  ): Promise<PassSecret> {
    const propertyId = this.propertyOf(access);
    // A random code may, very rarely, equal a live code at the property: draw again.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const secret = newPassSecret();
      try {
        await uow.createPass(
          invitationId,
          hashToken(secret.token),
          hashCode(propertyId, secret.code),
        );
        return secret;
      } catch (error) {
        if (!(error instanceof PassCodeCollision)) throw error;
      }
    }
    throw new Error('Could not draw a unique pass code');
  }

  private async revoke(uow: VisitorsUnitOfWork, invitation: InvitationRecord) {
    if (invitation.status === 'REVOKED') return invitation;
    await uow.revokeInvitation(invitation.id, this.clock.now());
    await uow.audit({ action: 'visitor_invitation.revoked', resourceId: invitation.id });
    return (await uow.invitation(invitation.id)) as InvitationRecord;
  }

  private async enforceValidateLimit(userId: string): Promise<void> {
    let state: { count: number; resetInMs: number };
    try {
      state = await this.limiter.hit(`gate:validate:user:${userId}`, VALIDATE_LIMIT.windowMs);
    } catch (error) {
      this.logger.warn(
        `Rate limiter unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Temporarily unavailable. Try again shortly.');
    }
    if (state.count > VALIDATE_LIMIT.limit) {
      throw new ApiError(429, 'RATE_LIMITED', 'Too many pass checks. Wait a moment.', {
        retryAfterSeconds: Math.max(1, Math.ceil(state.resetInMs / 1000)),
      });
    }
  }

  private unitOf(access: OrganisationAccess): string {
    if (!access.unitId) throw new Error('Unit route without a resolved unit');
    return access.unitId;
  }

  private propertyOf(access: OrganisationAccess): string {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    return access.propertyId;
  }

  private async inProperty<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: VisitorsUnitOfWork) => Promise<T>,
    onCheckViolation?: () => ApiError,
  ): Promise<T> {
    try {
      return await this.repository.inProperty(
        access.organisationId,
        this.propertyOf(access),
        access.userId,
        meta,
        work,
      );
    } catch (error) {
      // 23514: a CHECK or backstop trigger refused; 23505: a walk-in approval already used.
      const code = databaseErrorCode(error);
      if (onCheckViolation && (code === '23514' || code === '23505')) throw onCheckViolation();
      throw error;
    }
  }
}

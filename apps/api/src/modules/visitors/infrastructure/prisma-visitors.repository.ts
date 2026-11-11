import { Inject, Injectable } from '@nestjs/common';
import {
  type DbClient,
  type DbTransaction,
  isUniqueViolation,
  withTenantTransaction,
} from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import {
  type AccessEventType,
  type InvitationRecord,
  type NewVisit,
  PassCodeCollision,
  type PassRecord,
  type VisitorAuditEvent,
  type VisitorsRepository,
  type VisitorsUnitOfWork,
  type VisitRecord,
} from '../application/visitor-ports';
import type { CreateInvitationInput } from '../domain/visitor-rules';

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

const INVITATION_SELECT = {
  id: true,
  unitId: true,
  hostPersonId: true,
  createdByUserId: true,
  category: true,
  visitorName: true,
  visitorPhone: true,
  vehiclePlate: true,
  validFrom: true,
  validUntil: true,
  maxEntries: true,
  status: true,
  revokedAt: true,
  createdAt: true,
  unit: { select: { number: true } },
  _count: { select: { visits: { where: { decision: 'ADMITTED' as const } } } },
} as const;

type InvitationRow = {
  id: string;
  unitId: string;
  hostPersonId: string | null;
  createdByUserId: string;
  category: InvitationRecord['category'];
  visitorName: string;
  visitorPhone: string | null;
  vehiclePlate: string | null;
  validFrom: Date;
  validUntil: Date;
  maxEntries: number;
  status: InvitationRecord['status'];
  revokedAt: Date | null;
  createdAt: Date;
  unit: { number: string };
  _count: { visits: number };
};

const toInvitation = ({ unit, _count, ...row }: InvitationRow): InvitationRecord => ({
  ...row,
  unitNumber: unit.number,
  entriesUsed: _count.visits,
});

const VISIT_SELECT = {
  id: true,
  unitId: true,
  invitationId: true,
  category: true,
  visitorName: true,
  vehiclePlate: true,
  decision: true,
  denialReason: true,
  gate: true,
  arrivedAt: true,
  departedAt: true,
  source: true,
  unit: { select: { number: true } },
} as const;

type VisitRow = Omit<VisitRecord, 'unitNumber'> & { unit: { number: string } | null };

const toVisit = ({ unit, ...row }: VisitRow): VisitRecord => ({
  ...row,
  unitNumber: unit?.number ?? null,
});

class PrismaVisitorsUnitOfWork implements VisitorsUnitOfWork {
  constructor(
    private readonly tx: DbTransaction,
    private readonly organisationId: string,
    private readonly propertyId: string,
    private readonly userId: string,
    private readonly meta: RequestMeta,
  ) {}

  private get scope() {
    return { organisationId: this.organisationId, propertyId: this.propertyId };
  }

  unit(unitId: string) {
    return this.tx.unit.findFirst({
      where: { id: unitId, ...this.scope },
      select: { id: true, number: true, status: true },
    });
  }

  async myPersonId(): Promise<string | null> {
    const person = await this.tx.person.findFirst({
      where: { organisationId: this.organisationId, userId: this.userId, status: 'ACTIVE' },
      select: { id: true },
    });
    return person?.id ?? null;
  }

  async createInvitation(
    unitId: string,
    hostPersonId: string | null,
    input: CreateInvitationInput,
  ) {
    const row = await this.tx.visitorInvitation.create({
      data: {
        ...this.scope,
        unitId,
        hostPersonId,
        createdByUserId: this.userId,
        category: input.category,
        visitorName: input.visitorName,
        visitorPhone: input.visitorPhone ?? null,
        vehiclePlate: input.vehiclePlate ?? null,
        validFrom: input.validFrom,
        validUntil: input.validUntil,
        maxEntries: input.maxEntries,
      },
      select: { id: true },
    });
    return row.id;
  }

  async createPass(invitationId: string, tokenHash: string, codeHash: string) {
    try {
      // A savepoint keeps the transaction usable if the code collides and is drawn again.
      await this.tx.$executeRaw`SAVEPOINT visitor_pass`;
      const row = await this.tx.visitorPass.create({
        data: { ...this.scope, invitationId, tokenHash, codeHash },
        select: { id: true },
      });
      await this.tx.$executeRaw`RELEASE SAVEPOINT visitor_pass`;
      return row.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        await this.tx.$executeRaw`ROLLBACK TO SAVEPOINT visitor_pass`;
        throw new PassCodeCollision();
      }
      throw error;
    }
  }

  async invitation(invitationId: string, options: { lock?: boolean } = {}) {
    if (options.lock) {
      // Serialises admissions and revocations of one invitation (the backstop locks it too).
      await this.tx.$queryRaw`
        SELECT "id" FROM "visitor_invitations"
         WHERE "id" = ${invitationId}::uuid AND "organisation_id" = ${this.organisationId}::uuid
           AND "property_id" = ${this.propertyId}::uuid
         FOR UPDATE`;
    }
    const row = await this.tx.visitorInvitation.findFirst({
      where: { id: invitationId, ...this.scope },
      select: INVITATION_SELECT,
    });
    return row ? toInvitation(row as InvitationRow) : null;
  }

  async unitInvitations(unitId: string, endedAfter: Date) {
    const rows = await this.tx.visitorInvitation.findMany({
      where: { ...this.scope, unitId, validUntil: { gte: endedAfter } },
      select: INVITATION_SELECT,
      orderBy: { validFrom: 'desc' },
      take: 200,
    });
    return rows.map((row) => toInvitation(row as InvitationRow));
  }

  async propertyInvitations(endedAfter: Date) {
    const rows = await this.tx.visitorInvitation.findMany({
      where: { ...this.scope, validUntil: { gte: endedAfter } },
      select: INVITATION_SELECT,
      orderBy: { validFrom: 'desc' },
      take: 500,
    });
    return rows.map((row) => toInvitation(row as InvitationRow));
  }

  async revokeInvitation(invitationId: string, at: Date) {
    await this.tx.visitorInvitation.updateMany({
      where: { id: invitationId, ...this.scope, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: at, revokedByUserId: this.userId },
    });
    await this.tx.visitorPass.updateMany({
      where: { invitationId, ...this.scope, revokedAt: null },
      data: { revokedAt: at },
    });
  }

  private findPass(where: { tokenHash: string } | { codeHash: string } | { id: string }) {
    return this.tx.visitorPass.findFirst({
      where: { ...where, ...this.scope },
      select: { id: true, invitationId: true, revokedAt: true },
    });
  }

  passByTokenHash(tokenHash: string): Promise<PassRecord | null> {
    return this.findPass({ tokenHash });
  }

  async passByCodeHash(codeHash: string): Promise<PassRecord | null> {
    // A code is only unique among live passes: prefer the live one.
    const live = await this.tx.visitorPass.findFirst({
      where: { codeHash, ...this.scope, revokedAt: null },
      select: { id: true, invitationId: true, revokedAt: true },
    });
    return live ?? this.findPass({ codeHash });
  }

  pass(passId: string): Promise<PassRecord | null> {
    return this.findPass({ id: passId });
  }

  async hostStillResident(invitationId: string): Promise<boolean> {
    // Same rule as app_resident_grants: an active profile with a non-voided record on the unit
    // whose inclusive period contains the property's local date today.
    const rows = await this.tx.$queryRaw<{ ok: boolean }[]>`
      SELECT (i."host_person_id" IS NULL) OR (
               EXISTS (SELECT 1 FROM "persons" pe
                        WHERE pe."id" = i."host_person_id" AND pe."status" = 'ACTIVE')
               AND (
                 EXISTS (SELECT 1 FROM "ownerships" o
                          WHERE o."person_id" = i."host_person_id" AND o."unit_id" = i."unit_id"
                            AND o."voided_at" IS NULL AND o."effective_from" <= t."d"
                            AND (o."effective_to" IS NULL OR o."effective_to" >= t."d"))
                 OR EXISTS (SELECT 1 FROM "tenancy_occupants" oc
                              JOIN "tenancies" tn ON tn."id" = oc."tenancy_id"
                             WHERE oc."person_id" = i."host_person_id" AND tn."unit_id" = i."unit_id"
                               AND tn."voided_at" IS NULL AND tn."start_date" <= t."d"
                               AND (tn."end_date" IS NULL OR tn."end_date" >= t."d"))
                 OR EXISTS (SELECT 1 FROM "household_members" h
                             WHERE h."person_id" = i."host_person_id" AND h."unit_id" = i."unit_id"
                               AND h."voided_at" IS NULL AND h."valid_from" <= t."d"
                               AND (h."valid_to" IS NULL OR h."valid_to" >= t."d"))
               )
             ) AS ok
        FROM "visitor_invitations" i
        JOIN "properties" p ON p."id" = i."property_id"
        CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE p."time_zone")::date AS d) t
       WHERE i."id" = ${invitationId}::uuid AND i."organisation_id" = ${this.organisationId}::uuid
         AND i."property_id" = ${this.propertyId}::uuid`;
    return rows[0]?.ok ?? false;
  }

  async createVisit(visit: NewVisit): Promise<VisitRecord> {
    const row = await this.tx.visit.create({
      data: { ...this.scope, ...visit, recordedByUserId: this.userId, source: 'ONLINE' },
      select: VISIT_SELECT,
    });
    return toVisit(row as VisitRow);
  }

  async visit(visitId: string, options: { lock?: boolean } = {}) {
    if (options.lock) {
      await this.tx.$queryRaw`
        SELECT "id" FROM "visits"
         WHERE "id" = ${visitId}::uuid AND "organisation_id" = ${this.organisationId}::uuid
           AND "property_id" = ${this.propertyId}::uuid
         FOR UPDATE`;
    }
    const row = await this.tx.visit.findFirst({
      where: { id: visitId, ...this.scope },
      select: VISIT_SELECT,
    });
    return row ? toVisit(row as VisitRow) : null;
  }

  async recordDeparture(visitId: string, at: Date) {
    const row = await this.tx.visit.update({
      where: { id: visitId, ...this.scope },
      data: { departedAt: at, departureRecordedByUserId: this.userId },
      select: VISIT_SELECT,
    });
    return toVisit(row as VisitRow);
  }

  async visitorsInside() {
    const rows = await this.tx.visit.findMany({
      where: { ...this.scope, decision: 'ADMITTED', departedAt: null },
      select: VISIT_SELECT,
      orderBy: { arrivedAt: 'desc' },
      take: 500,
    });
    return rows.map((row) => toVisit(row as VisitRow));
  }

  async visitLog(from: Date, to: Date) {
    const rows = await this.tx.visit.findMany({
      where: { ...this.scope, arrivedAt: { gte: from, lt: to } },
      select: VISIT_SELECT,
      orderBy: { arrivedAt: 'desc' },
      take: 1000,
    });
    return rows.map((row) => toVisit(row as VisitRow));
  }

  async accessEvent(
    type: AccessEventType,
    at: Date,
    links: { invitationId?: string | null; visitId?: string | null; gate?: string | null },
  ) {
    await this.tx.accessEvent.create({
      data: {
        ...this.scope,
        type,
        occurredAt: at,
        actorUserId: this.userId,
        invitationId: links.invitationId ?? null,
        visitId: links.visitId ?? null,
        gate: links.gate ?? null,
      },
    });
  }

  async audit(event: VisitorAuditEvent) {
    await this.tx.auditLog.createMany({
      data: [
        {
          organisationId: this.organisationId,
          actorUserId: this.userId,
          action: event.action,
          resourceType: 'visitor_invitation',
          resourceId: event.resourceId,
          metadata: { propertyId: this.propertyId, ...(event.metadata ?? {}) },
          requestId: clip(this.meta.requestId, 128),
          ipAddress: clip(this.meta.ipAddress, 64),
        },
      ],
    });
  }
}

@Injectable()
export class PrismaVisitorsRepository implements VisitorsRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: VisitorsUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaVisitorsUnitOfWork(tx, organisationId, propertyId, userId, meta)),
      { userId },
    );
  }
}

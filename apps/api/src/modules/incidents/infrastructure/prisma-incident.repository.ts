import { Inject, Injectable } from '@nestjs/common';
import { type DbClient, type DbTransaction, withTenantTransaction } from '@veyra/db';
import { DB_CLIENT } from '../../../platform/infrastructure/infrastructure.module';
import type { RequestMeta } from '../../../platform/request-meta';
import type { TransactionHandle } from '../../../platform/transaction-handle';
import type {
  EscalationContactRecord,
  IncidentRecord,
  IncidentRepository,
  IncidentUnitOfWork,
} from '../application/incident-ports';

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));
const asDate = (d: string | null) => (d === null ? null : new Date(`${d}T00:00:00Z`));
const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const SELECT = {
  id: true,
  incidentNumber: true,
  category: true,
  severity: true,
  title: true,
  description: true,
  occurredAt: true,
  unit: { select: { id: true, number: true } },
  commonArea: { select: { id: true, name: true } },
  locationDetail: true,
  sensitive: true,
  status: true,
  outcome: true,
  reportedByUserId: true,
  reportedBy: { select: { displayName: true } },
  resolvedAt: true,
  closedAt: true,
  createdAt: true,
  _count: { select: { actions: { where: { doneAt: null } } } },
} as const;

type Row = Omit<IncidentRecord, 'number' | 'reportedByName' | 'openActions'> & {
  incidentNumber: bigint | null;
  reportedBy: { displayName: string };
  _count: { actions: number };
};

const toIncident = ({ incidentNumber, reportedBy, _count, ...row }: Row): IncidentRecord => ({
  ...row,
  number: Number(incidentNumber ?? 0),
  reportedByName: reportedBy.displayName,
  openActions: _count.actions,
});

const CONTACT = {
  id: true,
  name: true,
  role: true,
  phone: true,
  email: true,
  categories: true,
  position: true,
  active: true,
} as const;

class PrismaIncidentUnitOfWork implements IncidentUnitOfWork {
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

  transaction(): TransactionHandle {
    return this.tx as unknown as TransactionHandle;
  }

  async incidents(filter: { open: boolean }) {
    const rows = await this.tx.incident.findMany({
      where: { ...this.scope, ...(filter.open ? { status: { not: 'CLOSED' } } : {}) },
      select: SELECT,
      orderBy: [{ occurredAt: 'desc' }],
      take: 500,
    });
    return (rows as Row[]).map(toIncident);
  }

  async incident(id: string) {
    const row = await this.tx.incident.findFirst({ where: { ...this.scope, id }, select: SELECT });
    return row ? toIncident(row as Row) : null;
  }

  async createIncident(input: Parameters<IncidentUnitOfWork['createIncident']>[0]) {
    const row = await this.tx.incident.create({
      data: { ...this.scope, ...input, reportedByUserId: this.userId },
      select: { id: true },
    });
    return row.id;
  }

  async updateIncident(id: string, patch: Parameters<IncidentUnitOfWork['updateIncident']>[1]) {
    await this.tx.incident.updateMany({ where: { ...this.scope, id }, data: patch });
  }

  async updates(incidentId: string) {
    const rows = await this.tx.incidentUpdate.findMany({
      where: { ...this.scope, incidentId },
      select: {
        id: true,
        kind: true,
        fromStatus: true,
        toStatus: true,
        body: true,
        createdAt: true,
        actor: { select: { displayName: true } },
      },
      orderBy: { sequence: 'asc' },
    });
    return rows.map(({ actor, ...u }) => ({ ...u, actorName: actor?.displayName ?? null }));
  }

  async addNote(incidentId: string, body: string) {
    await this.tx.incidentUpdate.create({
      data: { ...this.scope, incidentId, kind: 'NOTE', body, actorUserId: this.userId },
    });
  }

  private readonly actionSelect = {
    id: true,
    description: true,
    assignedToUserId: true,
    assignedTo: { select: { displayName: true } },
    dueOn: true,
    doneAt: true,
    doneBy: { select: { displayName: true } },
    createdAt: true,
  } as const;

  private toAction(row: {
    id: string;
    description: string;
    assignedToUserId: string | null;
    assignedTo: { displayName: string } | null;
    dueOn: Date | null;
    doneAt: Date | null;
    doneBy: { displayName: string } | null;
    createdAt: Date;
  }) {
    const { assignedTo, doneBy, dueOn, ...rest } = row;
    return {
      ...rest,
      dueOn: isoDate(dueOn),
      assignedToName: assignedTo?.displayName ?? null,
      doneByName: doneBy?.displayName ?? null,
    };
  }

  async actions(incidentId: string) {
    const rows = await this.tx.incidentAction.findMany({
      where: { ...this.scope, incidentId },
      select: this.actionSelect,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.toAction(r));
  }

  async action(incidentId: string, id: string) {
    const row = await this.tx.incidentAction.findFirst({
      where: { ...this.scope, incidentId, id },
      select: this.actionSelect,
    });
    return row ? this.toAction(row) : null;
  }

  async addAction(input: Parameters<IncidentUnitOfWork['addAction']>[0]) {
    const row = await this.tx.incidentAction.create({
      data: { ...this.scope, ...input, dueOn: asDate(input.dueOn) },
      select: { id: true },
    });
    return row.id;
  }

  async completeAction(id: string) {
    // The database sets the time and the person (app_incident_action_guard).
    await this.tx.incidentAction.updateMany({
      where: { ...this.scope, id, doneAt: null },
      data: { doneAt: new Date(), doneByUserId: this.userId },
    });
  }

  async contacts(): Promise<EscalationContactRecord[]> {
    return this.tx.escalationContact.findMany({
      where: this.scope,
      select: CONTACT,
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  }

  async contact(id: string) {
    return this.tx.escalationContact.findFirst({ where: { ...this.scope, id }, select: CONTACT });
  }

  async createContact(input: Omit<EscalationContactRecord, 'id' | 'active'>) {
    const row = await this.tx.escalationContact.create({
      data: { ...this.scope, ...input },
      select: { id: true },
    });
    return row.id;
  }

  async updateContact(id: string, patch: Partial<Omit<EscalationContactRecord, 'id'>>) {
    await this.tx.escalationContact.updateMany({ where: { ...this.scope, id }, data: patch });
  }

  async audit(event: Parameters<IncidentUnitOfWork['audit']>[0]) {
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

/** Incident persistence over Prisma, always inside the organisation's RLS context. */
@Injectable()
export class PrismaIncidentRepository implements IncidentRepository {
  constructor(@Inject(DB_CLIENT) private readonly db: DbClient) {}

  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: IncidentUnitOfWork) => Promise<T>,
  ): Promise<T> {
    return withTenantTransaction(
      this.db,
      { organisationId },
      (tx) => work(new PrismaIncidentUnitOfWork(tx, organisationId, propertyId, userId, meta)),
      { userId },
    );
  }
}

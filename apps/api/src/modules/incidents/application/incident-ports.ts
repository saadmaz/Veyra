import type { RequestMeta } from '../../../platform/request-meta';
import type { TransactionHandle } from '../../../platform/transaction-handle';
import type { IncidentCategory, IncidentSeverity, IncidentStatus } from '../domain/incident-rules';

export interface IncidentRecord {
  id: string;
  number: number;
  category: IncidentCategory;
  severity: IncidentSeverity;
  title: string;
  description: string;
  occurredAt: Date;
  unit: { id: string; number: string } | null;
  commonArea: { id: string; name: string } | null;
  locationDetail: string | null;
  sensitive: boolean;
  status: IncidentStatus;
  outcome: string | null;
  reportedByUserId: string;
  reportedByName: string;
  resolvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  openActions: number;
}

export interface IncidentUpdateRecord {
  id: string;
  kind: 'STATUS_CHANGED' | 'NOTE';
  fromStatus: IncidentStatus | null;
  toStatus: IncidentStatus | null;
  body: string | null;
  actorName: string | null;
  createdAt: Date;
}

export interface IncidentActionRecord {
  id: string;
  description: string;
  assignedToUserId: string | null;
  assignedToName: string | null;
  dueOn: string | null;
  doneAt: Date | null;
  doneByName: string | null;
  createdAt: Date;
}

export interface EscalationContactRecord {
  id: string;
  name: string;
  role: string;
  phone: string;
  email: string | null;
  categories: IncidentCategory[];
  position: number;
  active: boolean;
}

/** One transaction in the organisation's RLS context, limited to one property. */
export interface IncidentUnitOfWork {
  /** The open transaction, for notifications committed with the change. */
  transaction(): TransactionHandle;
  incidents(filter: { open: boolean }): Promise<IncidentRecord[]>;
  incident(id: string): Promise<IncidentRecord | null>;
  createIncident(input: {
    category: IncidentCategory;
    severity: IncidentSeverity;
    title: string;
    description: string;
    occurredAt: Date;
    unitId: string | null;
    commonAreaId: string | null;
    locationDetail: string | null;
    sensitive: boolean;
  }): Promise<string>;
  updateIncident(
    id: string,
    patch: {
      category?: IncidentCategory;
      severity?: IncidentSeverity;
      sensitive?: boolean;
      status?: IncidentStatus;
      outcome?: string | null;
    },
  ): Promise<void>;
  updates(incidentId: string): Promise<IncidentUpdateRecord[]>;
  addNote(incidentId: string, body: string): Promise<void>;
  actions(incidentId: string): Promise<IncidentActionRecord[]>;
  action(incidentId: string, id: string): Promise<IncidentActionRecord | null>;
  addAction(input: {
    incidentId: string;
    description: string;
    assignedToUserId: string | null;
    dueOn: string | null;
  }): Promise<string>;
  completeAction(id: string): Promise<void>;
  contacts(): Promise<EscalationContactRecord[]>;
  contact(id: string): Promise<EscalationContactRecord | null>;
  createContact(input: Omit<EscalationContactRecord, 'id' | 'active'>): Promise<string>;
  updateContact(id: string, patch: Partial<Omit<EscalationContactRecord, 'id'>>): Promise<void>;
  audit(event: {
    action: string;
    resourceType: 'incident' | 'escalation_contact';
    resourceId: string;
    metadata?: Record<string, string | number | boolean>;
  }): Promise<void>;
}

export interface IncidentRepository {
  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: IncidentUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export const INCIDENT_REPOSITORY = Symbol('INCIDENT_REPOSITORY');

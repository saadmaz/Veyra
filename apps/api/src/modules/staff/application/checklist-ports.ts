import type { RequestMeta } from '../../../platform/request-meta';
import type { ChecklistResult, ChecklistStatus } from '../domain/checklist-rules';

export interface TemplateRecord {
  id: string;
  title: string;
  departmentId: string | null;
  departmentName: string | null;
  items: string[];
  status: 'ACTIVE' | 'ARCHIVED';
  createdAt: Date;
}

export interface RunItemRecord {
  position: number;
  text: string;
  result: ChecklistResult | null;
  note: string | null;
  answeredAt: Date | null;
}

export interface RunRecord {
  id: string;
  templateId: string;
  title: string;
  assignedToUserId: string;
  assignedToName: string;
  shiftId: string | null;
  dueOn: string;
  status: ChecklistStatus;
  submittedAt: Date | null;
  verifiedAt: Date | null;
  verifiedByName: string | null;
  statusNote: string | null;
  createdAt: Date;
  items: RunItemRecord[];
}

/** One transaction in the organisation's RLS context, limited to one property. */
export interface ChecklistUnitOfWork {
  templates(includeArchived: boolean): Promise<TemplateRecord[]>;
  template(id: string): Promise<TemplateRecord | null>;
  department(id: string): Promise<{ id: string; status: 'ACTIVE' | 'ARCHIVED' } | null>;
  createTemplate(input: {
    title: string;
    departmentId: string | null;
    items: string[];
  }): Promise<string>;
  updateTemplate(
    id: string,
    patch: { title?: string; departmentId?: string | null; items?: string[]; status?: 'ARCHIVED' },
  ): Promise<void>;
  shift(id: string): Promise<{ id: string; userId: string; status: string } | null>;
  runs(filter: { status?: ChecklistStatus; userId?: string }, limit: number): Promise<RunRecord[]>;
  run(id: string): Promise<RunRecord | null>;
  /** Creates the run and copies the template's checks into it. */
  createRun(input: {
    template: TemplateRecord;
    assignedToUserId: string;
    shiftId: string | null;
    dueOn: string;
  }): Promise<string>;
  answer(
    runId: string,
    position: number,
    result: ChecklistResult,
    note: string | null,
  ): Promise<boolean>;
  setStatus(id: string, status: ChecklistStatus, note: string | null): Promise<void>;
  audit(event: {
    action: string;
    resourceType: 'checklist_template' | 'checklist';
    resourceId: string;
    metadata?: Record<string, string | number | boolean>;
  }): Promise<void>;
}

export interface ChecklistRepository {
  inProperty<T>(
    organisationId: string,
    propertyId: string,
    userId: string,
    meta: RequestMeta,
    work: (uow: ChecklistUnitOfWork) => Promise<T>,
  ): Promise<T>;
}

export const CHECKLIST_REPOSITORY = Symbol('CHECKLIST_REPOSITORY');

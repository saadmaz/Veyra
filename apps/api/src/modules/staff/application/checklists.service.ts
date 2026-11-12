import { Inject, Injectable } from '@nestjs/common';
import { databaseErrorCode } from '@veyra/db';
import { ApiError } from '../../../platform/errors/api-error';
import type { RequestMeta } from '../../../platform/request-meta';
import { AccessControlService, type OrganisationAccess } from '../../access-control';
import {
  type AnswerInput,
  type AssignInput,
  type ChecklistStatus,
  complete,
  failures,
  type TemplateInput,
  type UpdateTemplateInput,
} from '../domain/checklist-rules';
import {
  CHECKLIST_REPOSITORY,
  type ChecklistRepository,
  type ChecklistUnitOfWork,
  type RunRecord,
} from './checklist-ports';

const templateNotFound = () => new ApiError(404, 'NOT_FOUND', 'Checklist template not found');
const runNotFound = () => new ApiError(404, 'NOT_FOUND', 'Checklist not found');
const invalidState = (message: string) => new ApiError(409, 'INVALID_STATE_TRANSITION', message);

/**
 * Checklists and inspections (Phase 9 Part 4). Supervisors (property.staff.manage) keep templates,
 * give checklists to staff, and verify, return or cancel them; staff (property.staff.work) see
 * only theirs, answer every check (a failed one needs a note) and submit. The person who did a
 * checklist never verifies it.
 */
@Injectable()
export class ChecklistsService {
  constructor(
    @Inject(CHECKLIST_REPOSITORY) private readonly repository: ChecklistRepository,
    private readonly accessControl: AccessControlService,
  ) {}

  // ------------------------------------------------------------------ templates

  templates(access: OrganisationAccess, meta: RequestMeta) {
    return this.run(access, meta, (uow) => uow.templates(true));
  }

  createTemplate(access: OrganisationAccess, input: TemplateInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      if (input.departmentId) await this.requireDepartment(uow, input.departmentId);
      const id = await uow.createTemplate({
        title: input.title,
        departmentId: input.departmentId ?? null,
        items: input.items,
      });
      await uow.audit({
        action: 'checklist_template.created',
        resourceType: 'checklist_template',
        resourceId: id,
      });
      return this.mustFindTemplate(uow, id);
    });
  }

  updateTemplate(
    access: OrganisationAccess,
    id: string,
    input: UpdateTemplateInput,
    meta: RequestMeta,
  ) {
    return this.run(access, meta, async (uow) => {
      const template = await this.mustFindTemplate(uow, id);
      if (template.status === 'ARCHIVED') throw invalidState('This template is archived');
      if (input.departmentId) await this.requireDepartment(uow, input.departmentId);
      const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      await uow.updateTemplate(id, patch);
      await uow.audit({
        action: 'checklist_template.updated',
        resourceType: 'checklist_template',
        resourceId: id,
        metadata: { fields: Object.keys(patch).join(',') },
      });
      return this.mustFindTemplate(uow, id);
    });
  }

  archiveTemplate(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const template = await this.mustFindTemplate(uow, id);
      if (template.status === 'ARCHIVED') throw invalidState('This template is already archived');
      await uow.updateTemplate(id, { status: 'ARCHIVED' });
      await uow.audit({
        action: 'checklist_template.archived',
        resourceType: 'checklist_template',
        resourceId: id,
      });
      return this.mustFindTemplate(uow, id);
    });
  }

  // ------------------------------------------------------------------ checklists (supervisors)

  runs(
    access: OrganisationAccess,
    filter: { status?: ChecklistStatus; userId?: string },
    meta: RequestMeta,
  ) {
    return this.run(access, meta, (uow) => uow.runs(filter, 500));
  }

  detail(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, (uow) => this.mustFindRun(uow, id));
  }

  assign(access: OrganisationAccess, input: AssignInput, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const template = await this.mustFindTemplate(uow, input.templateId);
      if (template.status === 'ARCHIVED') throw invalidState('This template is archived');
      const workers = await this.accessControl.usersWithPropertyPermission(
        access.organisationId,
        this.propertyOf(access),
        'property.staff.work',
      );
      if (!workers.some((w) => w.userId === input.assignedToUserId)) {
        throw new ApiError(422, 'VALIDATION_FAILED', 'This person does not work at this property');
      }
      if (input.shiftId) {
        const shift = await uow.shift(input.shiftId);
        if (!shift) throw new ApiError(404, 'NOT_FOUND', 'Shift not found');
        if (
          shift.userId !== input.assignedToUserId ||
          !['SCHEDULED', 'STARTED'].includes(shift.status)
        ) {
          throw new ApiError(422, 'VALIDATION_FAILED', 'Choose a live shift of the same person');
        }
      }
      const id = await uow.createRun({
        template,
        assignedToUserId: input.assignedToUserId,
        shiftId: input.shiftId ?? null,
        dueOn: input.dueOn,
      });
      await uow.audit({
        action: 'checklist.assigned',
        resourceType: 'checklist',
        resourceId: id,
        metadata: { templateId: template.id, userId: input.assignedToUserId },
      });
      return this.mustFindRun(uow, id);
    });
  }

  verify(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const run = await this.mustFindRun(uow, id);
      if (run.status !== 'SUBMITTED')
        throw invalidState('Only a submitted checklist can be verified');
      if (run.assignedToUserId === access.userId) {
        throw new ApiError(403, 'OWN_CHECKLIST', 'Someone else verifies a checklist you did');
      }
      await uow.setStatus(id, 'VERIFIED', null);
      await uow.audit({
        action: 'checklist.verified',
        resourceType: 'checklist',
        resourceId: id,
        metadata: { failures: failures(run.items) },
      });
      return this.mustFindRun(uow, id);
    });
  }

  returnToWorker(access: OrganisationAccess, id: string, reason: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const run = await this.mustFindRun(uow, id);
      if (run.status !== 'SUBMITTED')
        throw invalidState('Only a submitted checklist can be returned');
      await uow.setStatus(id, 'OPEN', reason);
      await uow.audit({ action: 'checklist.returned', resourceType: 'checklist', resourceId: id });
      return this.mustFindRun(uow, id);
    });
  }

  cancel(access: OrganisationAccess, id: string, reason: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const run = await this.mustFindRun(uow, id);
      if (run.status !== 'OPEN' && run.status !== 'SUBMITTED') {
        throw invalidState('This checklist is finished');
      }
      await uow.setStatus(id, 'CANCELLED', reason);
      await uow.audit({ action: 'checklist.cancelled', resourceType: 'checklist', resourceId: id });
      return this.mustFindRun(uow, id);
    });
  }

  // ------------------------------------------------------------------ my checklists (staff)

  mine(access: OrganisationAccess, meta: RequestMeta) {
    return this.run(access, meta, (uow) => uow.runs({ userId: access.userId }, 200));
  }

  myRun(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, (uow) => this.mustFindOwnRun(uow, access, id));
  }

  answer(
    access: OrganisationAccess,
    id: string,
    position: number,
    input: AnswerInput,
    meta: RequestMeta,
  ) {
    return this.run(access, meta, async (uow) => {
      const run = await this.mustFindOwnRun(uow, access, id);
      if (run.status !== 'OPEN') throw invalidState('This checklist is not open for answers');
      if (!(await uow.answer(id, position, input.result, input.note ?? null))) {
        throw new ApiError(404, 'NOT_FOUND', 'No such check on this checklist');
      }
      return this.mustFindRun(uow, id);
    });
  }

  submit(access: OrganisationAccess, id: string, meta: RequestMeta) {
    return this.run(access, meta, async (uow) => {
      const run = await this.mustFindOwnRun(uow, access, id);
      if (run.status !== 'OPEN') throw invalidState('This checklist is not open');
      if (!complete(run.items)) {
        throw new ApiError(422, 'INCOMPLETE', 'Answer every check before submitting');
      }
      await uow.setStatus(id, 'SUBMITTED', null);
      await uow.audit({
        action: 'checklist.submitted',
        resourceType: 'checklist',
        resourceId: id,
        metadata: { failures: failures(run.items) },
      });
      return this.mustFindRun(uow, id);
    });
  }

  // ------------------------------------------------------------------ shared

  private async mustFindTemplate(uow: ChecklistUnitOfWork, id: string) {
    const template = await uow.template(id);
    if (!template) throw templateNotFound();
    return template;
  }

  private async mustFindRun(uow: ChecklistUnitOfWork, id: string): Promise<RunRecord> {
    const run = await uow.run(id);
    if (!run) throw runNotFound();
    return run;
  }

  /** Someone else's checklist does not exist for the caller (404). */
  private async mustFindOwnRun(uow: ChecklistUnitOfWork, access: OrganisationAccess, id: string) {
    const run = await uow.run(id);
    if (!run || run.assignedToUserId !== access.userId) throw runNotFound();
    return run;
  }

  private async requireDepartment(uow: ChecklistUnitOfWork, id: string) {
    const department = await uow.department(id);
    if (department?.status !== 'ACTIVE') {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Choose an active department of this property');
    }
  }

  private propertyOf(access: OrganisationAccess) {
    if (!access.propertyId) throw new Error('Property route without a resolved property');
    return access.propertyId;
  }

  private async run<T>(
    access: OrganisationAccess,
    meta: RequestMeta,
    work: (uow: ChecklistUnitOfWork) => Promise<T>,
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
      if (databaseErrorCode(error) === '23514') {
        throw invalidState('This change is not possible any more. Reload and try again.');
      }
      throw error;
    }
  }
}

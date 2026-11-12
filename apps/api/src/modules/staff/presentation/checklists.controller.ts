import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ChecklistDto, ChecklistTemplateDto } from '@veyra/api-contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import type { RunRecord, TemplateRecord } from '../application/checklist-ports';
import { ChecklistsService } from '../application/checklists.service';
import {
  type AnswerInput,
  type AssignInput,
  answerSchema,
  assignSchema,
  checklistListQuerySchema,
  failures,
  noteSchema,
  type TemplateInput,
  templateSchema,
  type UpdateTemplateInput,
  updateTemplateSchema,
} from '../domain/checklist-rules';

const uuid = new ParseUUIDPipe();
const S = 'properties/:propertyId/staff';
const MY = 'properties/:propertyId/my-checklists';

const toTemplate = (t: TemplateRecord): ChecklistTemplateDto => ({
  id: t.id,
  title: t.title,
  department: t.departmentId ? { id: t.departmentId, name: t.departmentName ?? '' } : null,
  items: t.items,
  status: t.status,
  createdAt: t.createdAt.toISOString(),
});

const toRun = (r: RunRecord): ChecklistDto => ({
  id: r.id,
  templateId: r.templateId,
  title: r.title,
  assignedTo: { userId: r.assignedToUserId, name: r.assignedToName },
  shiftId: r.shiftId,
  dueOn: r.dueOn,
  status: r.status,
  submittedAt: r.submittedAt?.toISOString() ?? null,
  verifiedAt: r.verifiedAt?.toISOString() ?? null,
  verifiedBy: r.verifiedByName,
  statusNote: r.statusNote,
  failures: failures(r.items),
  answered: r.items.filter((i) => i.result !== null).length,
  createdAt: r.createdAt.toISOString(),
  items: r.items.map((i) => ({
    position: i.position,
    text: i.text,
    result: i.result,
    note: i.note,
    answeredAt: i.answeredAt?.toISOString() ?? null,
  })),
});

/** Checklist templates and checklists for supervisors; one's own checklists for staff. */
@ApiTags('staff')
@Controller('organisations/:organisationId')
export class ChecklistsController {
  constructor(private readonly checklists: ChecklistsService) {}

  @Get(`${S}/checklist-templates`)
  @RequirePermission('property.staff.read')
  @ApiOperation({ summary: 'Checklist templates (archived included).' })
  async templates(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: ChecklistTemplateDto[] }> {
    return { data: (await this.checklists.templates(access, requestMeta(req))).map(toTemplate) };
  }

  @Post(`${S}/checklist-templates`)
  @RequirePermission('property.staff.manage')
  @ApiOperation({ summary: 'Write a checklist template (1-50 checks).' })
  async createTemplate(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(templateSchema)) body: TemplateInput,
    @Req() req: Request,
  ): Promise<ChecklistTemplateDto> {
    return toTemplate(await this.checklists.createTemplate(access, body, requestMeta(req)));
  }

  @Patch(`${S}/checklist-templates/:templateId`)
  @RequirePermission('property.staff.manage')
  @ApiOperation({ summary: 'Change a template (checklists already given keep their checks).' })
  async updateTemplate(
    @CurrentAccess() access: OrganisationAccess,
    @Param('templateId', uuid) id: string,
    @Body(new ZodValidationPipe(updateTemplateSchema)) body: UpdateTemplateInput,
    @Req() req: Request,
  ): Promise<ChecklistTemplateDto> {
    return toTemplate(await this.checklists.updateTemplate(access, id, body, requestMeta(req)));
  }

  @Post(`${S}/checklist-templates/:templateId/archive`)
  @HttpCode(200)
  @RequirePermission('property.staff.manage')
  @ApiOperation({ summary: 'Stop using a template (final).' })
  async archiveTemplate(
    @CurrentAccess() access: OrganisationAccess,
    @Param('templateId', uuid) id: string,
    @Req() req: Request,
  ): Promise<ChecklistTemplateDto> {
    return toTemplate(await this.checklists.archiveTemplate(access, id, requestMeta(req)));
  }

  @Get(`${S}/checklists`)
  @RequirePermission('property.staff.read')
  @ApiOperation({ summary: 'Checklists, latest due first (at most 500).' })
  async runs(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(checklistListQuerySchema)) query: z.infer<
      typeof checklistListQuerySchema
    >,
    @Req() req: Request,
  ): Promise<{ data: ChecklistDto[] }> {
    return {
      data: (
        await this.checklists.runs(
          access,
          {
            ...(query.status ? { status: query.status } : {}),
            ...(query.userId ? { userId: query.userId } : {}),
          },
          requestMeta(req),
        )
      ).map(toRun),
    };
  }

  @Post(`${S}/checklists`)
  @RequirePermission('property.staff.manage')
  @ApiOperation({ summary: 'Give a checklist to someone who works here (optionally for a shift).' })
  async assign(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(assignSchema)) body: AssignInput,
    @Req() req: Request,
  ): Promise<ChecklistDto> {
    return toRun(await this.checklists.assign(access, body, requestMeta(req)));
  }

  @Get(`${S}/checklists/:checklistId`)
  @RequirePermission('property.staff.read')
  @ApiOperation({ summary: 'A checklist with its answers.' })
  async get(
    @CurrentAccess() access: OrganisationAccess,
    @Param('checklistId', uuid) id: string,
    @Req() req: Request,
  ): Promise<ChecklistDto> {
    return toRun(await this.checklists.detail(access, id, requestMeta(req)));
  }

  @Post(`${S}/checklists/:checklistId/verify`)
  @HttpCode(200)
  @RequirePermission('property.staff.manage')
  @ApiOperation({ summary: 'Confirm a submitted checklist (not your own).' })
  async verify(
    @CurrentAccess() access: OrganisationAccess,
    @Param('checklistId', uuid) id: string,
    @Req() req: Request,
  ): Promise<ChecklistDto> {
    return toRun(await this.checklists.verify(access, id, requestMeta(req)));
  }

  @Post(`${S}/checklists/:checklistId/return`)
  @HttpCode(200)
  @RequirePermission('property.staff.manage')
  @ApiOperation({ summary: 'Send a submitted checklist back, saying what to fix.' })
  async returnToWorker(
    @CurrentAccess() access: OrganisationAccess,
    @Param('checklistId', uuid) id: string,
    @Body(new ZodValidationPipe(noteSchema)) body: z.infer<typeof noteSchema>,
    @Req() req: Request,
  ): Promise<ChecklistDto> {
    return toRun(await this.checklists.returnToWorker(access, id, body.reason, requestMeta(req)));
  }

  @Post(`${S}/checklists/:checklistId/cancel`)
  @HttpCode(200)
  @RequirePermission('property.staff.manage')
  @ApiOperation({ summary: 'Call off a checklist, saying why.' })
  async cancel(
    @CurrentAccess() access: OrganisationAccess,
    @Param('checklistId', uuid) id: string,
    @Body(new ZodValidationPipe(noteSchema)) body: z.infer<typeof noteSchema>,
    @Req() req: Request,
  ): Promise<ChecklistDto> {
    return toRun(await this.checklists.cancel(access, id, body.reason, requestMeta(req)));
  }

  // ------------------------------------------------------------------ my checklists

  @Get(MY)
  @RequirePermission('property.staff.work')
  @ApiOperation({ summary: 'Your checklists, latest due first.' })
  async mine(
    @CurrentAccess() access: OrganisationAccess,
    @Req() req: Request,
  ): Promise<{ data: ChecklistDto[] }> {
    return { data: (await this.checklists.mine(access, requestMeta(req))).map(toRun) };
  }

  @Get(`${MY}/:checklistId`)
  @RequirePermission('property.staff.work')
  @ApiOperation({ summary: 'One of your checklists.' })
  async myRun(
    @CurrentAccess() access: OrganisationAccess,
    @Param('checklistId', uuid) id: string,
    @Req() req: Request,
  ): Promise<ChecklistDto> {
    return toRun(await this.checklists.myRun(access, id, requestMeta(req)));
  }

  @Put(`${MY}/:checklistId/items/:position`)
  @RequirePermission('property.staff.work')
  @ApiOperation({ summary: 'Answer a check (a failed one needs a note).' })
  async answer(
    @CurrentAccess() access: OrganisationAccess,
    @Param('checklistId', uuid) id: string,
    @Param('position', ParseIntPipe) position: number,
    @Body(new ZodValidationPipe(answerSchema)) body: AnswerInput,
    @Req() req: Request,
  ): Promise<ChecklistDto> {
    return toRun(await this.checklists.answer(access, id, position, body, requestMeta(req)));
  }

  @Post(`${MY}/:checklistId/submit`)
  @HttpCode(200)
  @RequirePermission('property.staff.work')
  @ApiOperation({ summary: 'Hand in your checklist once every check is answered.' })
  async submit(
    @CurrentAccess() access: OrganisationAccess,
    @Param('checklistId', uuid) id: string,
    @Req() req: Request,
  ): Promise<ChecklistDto> {
    return toRun(await this.checklists.submit(access, id, requestMeta(req)));
  }
}

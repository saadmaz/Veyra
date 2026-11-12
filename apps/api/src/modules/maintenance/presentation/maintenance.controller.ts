import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  MaintenanceAssigneeDto,
  MaintenanceEventDto,
  MaintenanceRequestDetailDto,
  MaintenanceRequestDto,
  WorkOrderDetailDto,
  WorkOrderDto,
} from '@veyra/api-contracts';
import type { Request } from 'express';
import type { z } from 'zod';
import { requestMeta } from '../../../platform/request-meta';
import { ZodValidationPipe } from '../../../platform/validation/zod-validation.pipe';
import { CurrentAccess, type OrganisationAccess, RequirePermission } from '../../access-control';
import { MaintenanceService } from '../application/maintenance.service';
import {
  type AcceptInput,
  acceptSchema,
  assignSchema,
  type CostInput,
  type CreateWorkOrderInput,
  completeSchema,
  costSchema,
  createWorkOrderSchema,
  myWorkQuerySchema,
  type NoteInput,
  noteSchema,
  optionalNoteSchema,
  reasonSchema,
  requestListQuerySchema,
  type StaffRequestInput,
  staffRequestSchema,
  updateRequestSchema,
  updateWorkOrderSchema,
  voidCostSchema,
  workOrderListQuerySchema,
} from '../domain/maintenance-rules';
import { toEvent, toRequest, toWorkOrder, toWorkOrderDetail } from './maintenance-dto';

const uuid = new ParseUUIDPipe();
const M = 'properties/:propertyId/maintenance';
const MINE = 'properties/:propertyId/my-work-orders';

/**
 * Maintenance for staff (Phase 7 Part 2): requests and work orders of a property. Reading needs
 * property.maintenance.read, everything else property.maintenance.manage. Technicians use the
 * "my work orders" routes below (property.maintenance.work) and see only their own work.
 */
@ApiTags('maintenance')
@Controller('organisations/:organisationId')
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  // ------------------------------------------------------------------ requests

  @Get(`${M}/requests`)
  @RequirePermission('property.maintenance.read')
  @ApiOperation({ summary: "The property's requests, newest first (at most 200)." })
  async requests(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(requestListQuerySchema))
    query: z.infer<typeof requestListQuerySchema>,
    @Req() req: Request,
  ): Promise<{ data: MaintenanceRequestDto[] }> {
    const rows = await this.maintenance.requests(access, query, requestMeta(req));
    return { data: rows.map(toRequest) };
  }

  @Post(`${M}/requests`)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Report a problem in a unit or a common area.' })
  async createRequest(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(staffRequestSchema)) body: StaffRequestInput,
    @Req() req: Request,
  ): Promise<MaintenanceRequestDto> {
    return toRequest(await this.maintenance.createRequest(access, body, requestMeta(req)));
  }

  @Get(`${M}/requests/:requestId`)
  @RequirePermission('property.maintenance.read')
  @ApiOperation({ summary: 'A request with its work orders and full history.' })
  async request(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) id: string,
    @Req() req: Request,
  ): Promise<MaintenanceRequestDetailDto> {
    const d = await this.maintenance.request(access, id, requestMeta(req));
    return {
      request: toRequest(d.request),
      workOrders: d.workOrders.map(toWorkOrder),
      events: d.events.map(toEvent),
    };
  }

  @Patch(`${M}/requests/:requestId`)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Change the priority (and SLA due times) or the category.' })
  async updateRequest(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) id: string,
    @Body(new ZodValidationPipe(updateRequestSchema)) body: z.infer<typeof updateRequestSchema>,
    @Req() req: Request,
  ): Promise<MaintenanceRequestDto> {
    return toRequest(await this.maintenance.updateRequest(access, id, body, requestMeta(req)));
  }

  @Post(`${M}/requests/:requestId/accept`)
  @HttpCode(200)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({
    summary: 'Take a new request on (optionally re-prioritise, tell the requester).',
  })
  async accept(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) id: string,
    @Body(new ZodValidationPipe(acceptSchema)) body: AcceptInput,
    @Req() req: Request,
  ): Promise<MaintenanceRequestDto> {
    return toRequest(await this.maintenance.accept(access, id, body, requestMeta(req)));
  }

  @Post(`${M}/requests/:requestId/reject`)
  @HttpCode(200)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Decline a new request; the reason is shown to the requester.' })
  async reject(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
    @Req() req: Request,
  ): Promise<MaintenanceRequestDto> {
    return toRequest(await this.maintenance.reject(access, id, body.reason, requestMeta(req)));
  }

  @Post(`${M}/requests/:requestId/cancel`)
  @HttpCode(200)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Withdraw a request with no open work; the reason is shown.' })
  async cancel(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
    @Req() req: Request,
  ): Promise<MaintenanceRequestDto> {
    return toRequest(await this.maintenance.cancel(access, id, body.reason, requestMeta(req)));
  }

  @Post(`${M}/requests/:requestId/resolve`)
  @HttpCode(200)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'The work is done; the requester is asked to confirm.' })
  async resolve(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) id: string,
    @Body(new ZodValidationPipe(optionalNoteSchema)) body: z.infer<typeof optionalNoteSchema>,
    @Req() req: Request,
  ): Promise<MaintenanceRequestDto> {
    return toRequest(await this.maintenance.resolve(access, id, body.note, requestMeta(req)));
  }

  @Post(`${M}/requests/:requestId/close`)
  @HttpCode(200)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Close a resolved request without waiting for the requester.' })
  async close(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) id: string,
    @Req() req: Request,
  ): Promise<MaintenanceRequestDto> {
    return toRequest(await this.maintenance.close(access, id, requestMeta(req)));
  }

  @Post(`${M}/requests/:requestId/notes`)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'An internal note, or an update shown to the requester.' })
  async requestNote(
    @CurrentAccess() access: OrganisationAccess,
    @Param('requestId', uuid) id: string,
    @Body(new ZodValidationPipe(noteSchema)) body: NoteInput,
    @Req() req: Request,
  ): Promise<{ data: MaintenanceEventDto[] }> {
    const events = await this.maintenance.addRequestNote(access, id, body, requestMeta(req));
    return { data: events.map(toEvent) };
  }

  // ------------------------------------------------------------------ work orders

  @Get(`${M}/assignees`)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'People who can be given maintenance work at this property.' })
  async assignees(
    @CurrentAccess() access: OrganisationAccess,
  ): Promise<{ data: MaintenanceAssigneeDto[] }> {
    const rows = await this.maintenance.assignees(access);
    return { data: rows.map((r) => ({ userId: r.userId, name: r.displayName })) };
  }

  @Get(`${M}/work-orders`)
  @RequirePermission('property.maintenance.read')
  @ApiOperation({ summary: "The property's work orders, newest first (at most 200)." })
  async workOrders(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(workOrderListQuerySchema))
    query: z.infer<typeof workOrderListQuerySchema>,
    @Req() req: Request,
  ): Promise<{ data: WorkOrderDto[] }> {
    const rows = await this.maintenance.workOrders(access, query, requestMeta(req));
    return { data: rows.map(toWorkOrder) };
  }

  @Post(`${M}/work-orders`)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Raise work for an accepted request, or directly for a place.' })
  async createWorkOrder(
    @CurrentAccess() access: OrganisationAccess,
    @Body(new ZodValidationPipe(createWorkOrderSchema)) body: CreateWorkOrderInput,
    @Req() req: Request,
  ): Promise<WorkOrderDetailDto> {
    return toWorkOrderDetail(
      await this.maintenance.createWorkOrder(access, body, requestMeta(req)),
    );
  }

  @Get(`${M}/work-orders/:workOrderId`)
  @RequirePermission('property.maintenance.read')
  @ApiOperation({ summary: 'A work order with its costs and history.' })
  async workOrder(
    @CurrentAccess() access: OrganisationAccess,
    @Param('workOrderId', uuid) id: string,
    @Req() req: Request,
  ): Promise<WorkOrderDetailDto> {
    return toWorkOrderDetail(await this.maintenance.workOrder(access, id, requestMeta(req)));
  }

  @Patch(`${M}/work-orders/:workOrderId`)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Change the priority or the due time of live work.' })
  async updateWorkOrder(
    @CurrentAccess() access: OrganisationAccess,
    @Param('workOrderId', uuid) id: string,
    @Body(new ZodValidationPipe(updateWorkOrderSchema)) body: z.infer<typeof updateWorkOrderSchema>,
    @Req() req: Request,
  ): Promise<WorkOrderDetailDto> {
    return toWorkOrderDetail(
      await this.maintenance.updateWorkOrder(access, id, body, requestMeta(req)),
    );
  }

  @Post(`${M}/work-orders/:workOrderId/assign`)
  @HttpCode(200)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Give the work to a technician or manager (or reassign it).' })
  async assign(
    @CurrentAccess() access: OrganisationAccess,
    @Param('workOrderId', uuid) id: string,
    @Body(new ZodValidationPipe(assignSchema)) body: z.infer<typeof assignSchema>,
    @Req() req: Request,
  ): Promise<WorkOrderDetailDto> {
    return toWorkOrderDetail(
      await this.maintenance.assign(access, id, body.userId, requestMeta(req)),
    );
  }

  @Post(`${M}/work-orders/:workOrderId/unassign`)
  @HttpCode(200)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Take assigned work that has not started back to the open pool.' })
  async unassign(
    @CurrentAccess() access: OrganisationAccess,
    @Param('workOrderId', uuid) id: string,
    @Req() req: Request,
  ): Promise<WorkOrderDetailDto> {
    return toWorkOrderDetail(await this.maintenance.unassign(access, id, requestMeta(req)));
  }

  @Post(`${M}/work-orders/:workOrderId/cancel`)
  @HttpCode(200)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Cancel live work, with a reason.' })
  async cancelWorkOrder(
    @CurrentAccess() access: OrganisationAccess,
    @Param('workOrderId', uuid) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
    @Req() req: Request,
  ): Promise<WorkOrderDetailDto> {
    return toWorkOrderDetail(
      await this.maintenance.cancelWorkOrder(access, id, body.reason, requestMeta(req)),
    );
  }

  @Post(`${M}/work-orders/:workOrderId/notes`)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'A note on the work (shown to the requester when RESIDENT).' })
  async workOrderNote(
    @CurrentAccess() access: OrganisationAccess,
    @Param('workOrderId', uuid) id: string,
    @Body(new ZodValidationPipe(noteSchema)) body: NoteInput,
    @Req() req: Request,
  ): Promise<WorkOrderDetailDto> {
    return toWorkOrderDetail(
      await this.maintenance.addWorkOrderNote(access, id, body, requestMeta(req)),
    );
  }

  @Post(`${M}/work-orders/:workOrderId/costs`)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({
    summary: 'Record labour, materials or other cost (for reporting; never billed).',
  })
  async recordCost(
    @CurrentAccess() access: OrganisationAccess,
    @Param('workOrderId', uuid) id: string,
    @Body(new ZodValidationPipe(costSchema)) body: CostInput,
    @Req() req: Request,
  ): Promise<WorkOrderDetailDto> {
    return toWorkOrderDetail(await this.maintenance.recordCost(access, id, body, requestMeta(req)));
  }

  @Post(`${M}/costs/:costId/void`)
  @HttpCode(200)
  @RequirePermission('property.maintenance.manage')
  @ApiOperation({ summary: 'Void a cost recorded by mistake (it is never edited).' })
  async voidCost(
    @CurrentAccess() access: OrganisationAccess,
    @Param('costId', uuid) id: string,
    @Body(new ZodValidationPipe(voidCostSchema)) body: z.infer<typeof voidCostSchema>,
    @Req() req: Request,
  ): Promise<WorkOrderDetailDto> {
    return toWorkOrderDetail(
      await this.maintenance.voidCost(access, id, body.reason, requestMeta(req)),
    );
  }

  // ------------------------------------------------------------------ my work (technicians)

  @Get(MINE)
  @RequirePermission('property.maintenance.work')
  @ApiOperation({ summary: 'Work assigned to you, newest first.' })
  async myWork(
    @CurrentAccess() access: OrganisationAccess,
    @Query(new ZodValidationPipe(myWorkQuerySchema)) query: z.infer<typeof myWorkQuerySchema>,
    @Req() req: Request,
  ): Promise<{ data: WorkOrderDto[] }> {
    const rows = await this.maintenance.myWorkOrders(access, query.status, requestMeta(req));
    return { data: rows.map(toWorkOrder) };
  }

  @Get(`${MINE}/:workOrderId`)
  @RequirePermission('property.maintenance.work')
  @ApiOperation({ summary: 'One of your work orders (anyone else’s is 404).' })
  async myWorkOrder(
    @CurrentAccess() access: OrganisationAccess,
    @Param('workOrderId', uuid) id: string,
    @Req() req: Request,
  ): Promise<WorkOrderDetailDto> {
    return toWorkOrderDetail(await this.maintenance.myWorkOrder(access, id, requestMeta(req)));
  }

  @Post(`${MINE}/:workOrderId/start`)
  @HttpCode(200)
  @RequirePermission('property.maintenance.work')
  @ApiOperation({ summary: 'Start (or resume) your work.' })
  async start(
    @CurrentAccess() access: OrganisationAccess,
    @Param('workOrderId', uuid) id: string,
    @Req() req: Request,
  ): Promise<WorkOrderDetailDto> {
    return toWorkOrderDetail(
      await this.maintenance.progress(access, id, 'IN_PROGRESS', null, requestMeta(req)),
    );
  }

  @Post(`${MINE}/:workOrderId/hold`)
  @HttpCode(200)
  @RequirePermission('property.maintenance.work')
  @ApiOperation({ summary: 'Pause your work, saying why (e.g. waiting for a part).' })
  async hold(
    @CurrentAccess() access: OrganisationAccess,
    @Param('workOrderId', uuid) id: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: z.infer<typeof reasonSchema>,
    @Req() req: Request,
  ): Promise<WorkOrderDetailDto> {
    return toWorkOrderDetail(
      await this.maintenance.progress(access, id, 'ON_HOLD', body.reason, requestMeta(req)),
    );
  }

  @Post(`${MINE}/:workOrderId/complete`)
  @HttpCode(200)
  @RequirePermission('property.maintenance.work')
  @ApiOperation({ summary: 'Finish your work, saying what was done.' })
  async complete(
    @CurrentAccess() access: OrganisationAccess,
    @Param('workOrderId', uuid) id: string,
    @Body(new ZodValidationPipe(completeSchema)) body: z.infer<typeof completeSchema>,
    @Req() req: Request,
  ): Promise<WorkOrderDetailDto> {
    return toWorkOrderDetail(
      await this.maintenance.progress(access, id, 'COMPLETED', body.note, requestMeta(req)),
    );
  }

  @Post(`${MINE}/:workOrderId/notes`)
  @RequirePermission('property.maintenance.work')
  @ApiOperation({ summary: 'A note on your work (shown to the requester when RESIDENT).' })
  async myNote(
    @CurrentAccess() access: OrganisationAccess,
    @Param('workOrderId', uuid) id: string,
    @Body(new ZodValidationPipe(noteSchema)) body: NoteInput,
    @Req() req: Request,
  ): Promise<WorkOrderDetailDto> {
    return toWorkOrderDetail(await this.maintenance.addMyNote(access, id, body, requestMeta(req)));
  }

  @Post(`${MINE}/:workOrderId/costs`)
  @RequirePermission('property.maintenance.work')
  @ApiOperation({ summary: 'Record labour or materials on your work.' })
  async myCost(
    @CurrentAccess() access: OrganisationAccess,
    @Param('workOrderId', uuid) id: string,
    @Body(new ZodValidationPipe(costSchema)) body: CostInput,
    @Req() req: Request,
  ): Promise<WorkOrderDetailDto> {
    return toWorkOrderDetail(
      await this.maintenance.recordMyCost(access, id, body, requestMeta(req)),
    );
  }
}

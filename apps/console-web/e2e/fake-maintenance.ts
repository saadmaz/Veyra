import { randomUUID } from 'node:crypto';
import type {
  MaintenanceAttachmentDto,
  MaintenanceEventDto,
  MaintenancePriority,
  MaintenanceRequestDto,
  MaintenanceRequestStatus,
  MaintenanceSlaTargetDto,
  UnitDto,
  WorkOrderCostDto,
  WorkOrderDto,
  WorkOrderStatus,
} from '@veyra/api-contracts';

/**
 * In-memory maintenance endpoints for the browser journeys (Phase 7). It follows the wire
 * contracts and the main rules of the real API (transitions, resident-visible history, only the
 * assignee works, files checked before they show); the API's own tests prove the real rules.
 */

export const STORAGE_ORIGIN = 'https://storage.example.test';

interface Ctx {
  method: string;
  /** Below the property, e.g. /maintenance/requests or /my-work-orders/x. */
  sub: string;
  body: Record<string, unknown>;
  url: URL;
  property: { id: string; currency: string };
  permissions: string[];
  user: { id: string; displayName: string };
  units: UnitDto[];
  commonAreas: { id: string; name: string }[];
  /** People holding property.maintenance.work here. */
  assignees: { userId: string; name: string }[];
}

interface UnitCtx extends Omit<Ctx, 'sub' | 'permissions' | 'assignees' | 'commonAreas'> {
  /** Below /maintenance-requests. */
  sub: string;
  unit: UnitDto;
  isResident: boolean;
}

interface Reply {
  status: number;
  body?: unknown;
}

type Req = MaintenanceRequestDto & { propertyId: string };
type Work = WorkOrderDto & { propertyId: string };
type Attachment = MaintenanceAttachmentDto & {
  propertyId: string;
  requestId: string | null;
  key: string;
  status: 'PENDING' | 'READY';
  removed: boolean;
};

const ok = (body?: unknown, status = 200): Reply => ({ status, body });
const fail = (status: number, code: string, message = code): Reply => ({
  status,
  body: { error: { code, message, details: [], requestId: 'fake' } },
});
const now = () => new Date().toISOString();
const pad = (prefix: string, n: number) => `${prefix}-${String(n).padStart(6, '0')}`;
const LIVE_WORK: WorkOrderStatus[] = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'];

/** JPEG, PNG, WebP or PDF by their first bytes (HEIC skipped in the fake). */
function sniff(bytes: Uint8Array): string | null {
  const s = (a: number, b: number) => String.fromCharCode(...bytes.slice(a, b));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && s(1, 4) === 'PNG') return 'image/png';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'image/webp';
  if (s(0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

export class FakeMaintenance {
  requests: Req[] = [];
  work: Work[] = [];
  events: (MaintenanceEventDto & { requestId: string | null; workOrderId: string | null })[] = [];
  costs: (WorkOrderCostDto & { workOrderId: string })[] = [];
  attachments: Attachment[] = [];
  targets = new Map<string, MaintenanceSlaTargetDto[]>();
  objects = new Map<string, Uint8Array>();
  private counters = new Map<string, number>();

  private next(propertyId: string, prefix: string) {
    const key = `${propertyId}:${prefix}`;
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return pad(prefix, n);
  }

  // ------------------------------------------------------------------ seeding and storage

  setTargets(propertyId: string, targets: MaintenanceSlaTargetDto[]) {
    this.targets.set(propertyId, targets);
  }

  /** The browser's PUT to a signed URL. */
  storeUpload(url: URL, bytes: Uint8Array): number {
    const key = url.pathname.slice(1);
    if (!this.attachments.some((a) => a.key === key && a.status === 'PENDING')) return 403;
    this.objects.set(key, bytes);
    return 200;
  }

  private log(
    r: { requestId: string | null; workOrderId: string | null; workOrderNumber?: string | null },
    type: MaintenanceEventDto['type'],
    visibility: 'RESIDENT' | 'INTERNAL',
    from: string | null,
    to: string | null,
    body: string | null,
    actor: { id: string; displayName: string } | null,
  ) {
    this.events.push({
      id: randomUUID(),
      requestId: r.requestId,
      workOrderId: r.workOrderId,
      type,
      visibility,
      from,
      to,
      body,
      actor: actor ? { userId: actor.id, name: actor.displayName } : null,
      workOrderNumber: r.workOrderNumber ?? null,
      createdAt: now(),
    });
  }

  private due(propertyId: string, priority: MaintenancePriority, created: string) {
    const t = (this.targets.get(propertyId) ?? []).find((x) => x.priority === priority);
    const at = (m: number) => new Date(Date.parse(created) + m * 60_000).toISOString();
    return {
      responseDueAt: t ? at(t.responseMinutes) : null,
      resolutionDueAt: t ? at(t.resolutionMinutes) : null,
    };
  }

  private view(r: Req): MaintenanceRequestDto {
    const past = (iso: string | null) => iso !== null && Date.parse(iso) <= Date.now();
    const { propertyId: _, ...dto } = r;
    return {
      ...dto,
      overdue: {
        response: r.status === 'SUBMITTED' && past(r.responseDueAt),
        resolution:
          (r.status === 'SUBMITTED' || r.status === 'ACCEPTED') && past(r.resolutionDueAt),
      },
    };
  }

  private workView(w: Work): WorkOrderDto {
    const { propertyId: _, ...dto } = w;
    return dto;
  }

  private attachmentView(a: Attachment): MaintenanceAttachmentDto {
    const { propertyId: _p, requestId: _r, key: _k, status: _s, removed: _x, ...dto } = a;
    return dto;
  }

  private filesOf(target: { requestId: string } | { workOrderId: string }, residentsOnly: boolean) {
    return this.attachments
      .filter((a) =>
        'requestId' in target
          ? a.requestId === target.requestId
          : a.workOrderId === target.workOrderId,
      )
      .filter((a) => a.status === 'READY' && !a.removed)
      .filter((a) => !residentsOnly || a.visibility === 'RESIDENT')
      .map((a) => this.attachmentView(a));
  }

  private workDetail(w: Work, currency: string) {
    const costs = this.costs.filter((c) => c.workOrderId === w.id);
    const total = costs
      .filter((c) => !c.voidedAt)
      .reduce((s, c) => s + BigInt(c.amount.amountMinor), 0n);
    return {
      workOrder: this.workView(w),
      costs: costs.map(({ workOrderId: _, ...c }) => c),
      totalCost: { amountMinor: total.toString(), currency },
      events: this.events.filter((e) => e.workOrderId === w.id).map(stripTarget),
      attachments: this.filesOf({ workOrderId: w.id }, false),
    };
  }

  private createRequest(
    propertyId: string,
    place: { unit: UnitDto | null; area: { id: string; name: string } | null },
    body: Record<string, unknown>,
    user: { id: string; displayName: string },
  ): Req | Reply {
    const title = String(body.title ?? '').trim();
    const description = String(body.description ?? '').trim();
    if (!title || !description) return fail(400, 'VALIDATION_FAILED');
    const priority = (String(body.priority ?? 'MEDIUM') || 'MEDIUM') as MaintenancePriority;
    const createdAt = now();
    const r: Req = {
      id: randomUUID(),
      propertyId,
      number: this.next(propertyId, 'MR'),
      unitId: place.unit?.id ?? null,
      unitNumber: place.unit?.number ?? null,
      commonAreaId: place.area?.id ?? null,
      commonAreaName: place.area?.name ?? null,
      category: String(body.category ?? 'OTHER') as Req['category'],
      priority,
      title,
      description,
      locationDetail:
        typeof body.locationDetail === 'string' ? body.locationDetail.trim() || null : null,
      status: 'SUBMITTED',
      statusNote: null,
      submittedBy: { userId: user.id, name: user.displayName },
      acceptedAt: null,
      ...this.due(propertyId, priority, createdAt),
      overdue: { response: false, resolution: false },
      responseBreachedAt: null,
      resolutionBreachedAt: null,
      resolvedAt: null,
      closedAt: null,
      reopenCount: 0,
      createdAt,
    };
    this.requests.push(r);
    this.log(
      { requestId: r.id, workOrderId: null },
      'STATUS_CHANGED',
      'RESIDENT',
      null,
      'SUBMITTED',
      null,
      user,
    );
    return r;
  }

  private move(
    r: Req,
    to: MaintenanceRequestStatus,
    note: string | null,
    user: { id: string; displayName: string },
  ): Reply | null {
    const allowed: Record<MaintenanceRequestStatus, MaintenanceRequestStatus[]> = {
      SUBMITTED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
      ACCEPTED: ['RESOLVED', 'CANCELLED'],
      RESOLVED: ['CLOSED', 'ACCEPTED'],
      CLOSED: [],
      REJECTED: [],
      CANCELLED: [],
    };
    if (!allowed[r.status].includes(to)) return fail(409, 'INVALID_STATE_TRANSITION');
    const from = r.status;
    r.status = to;
    r.statusNote = note;
    if (to === 'ACCEPTED' && from === 'SUBMITTED') r.acceptedAt = now();
    if (to === 'RESOLVED') r.resolvedAt = now();
    if (to === 'CLOSED') r.closedAt = now();
    if (from === 'RESOLVED' && to === 'ACCEPTED') {
      r.reopenCount += 1;
      r.resolvedAt = null;
    }
    this.log(
      { requestId: r.id, workOrderId: null },
      'STATUS_CHANGED',
      'RESIDENT',
      from,
      to,
      note,
      user,
    );
    return null;
  }

  // ------------------------------------------------------------------ attachments (shared)

  private ask(
    target: { request: Req | null; work: Work | null },
    body: Record<string, unknown>,
    user: { id: string; displayName: string },
    residents: boolean,
  ): Reply {
    const type = String(body.contentType ?? '');
    const size = Number(body.sizeBytes ?? 0);
    if (
      !['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'].includes(type) ||
      !(size > 0) ||
      size > 10 * 1024 * 1024
    ) {
      return fail(400, 'VALIDATION_FAILED');
    }
    const requestId = target.request?.id ?? target.work?.requestId ?? null;
    const id = randomUUID();
    const key = `org/fake/prop/fake/maintenance/${id}`;
    this.attachments.push({
      id,
      propertyId: '',
      requestId,
      workOrderId: target.work?.id ?? null,
      fileName: String(body.fileName ?? 'file'),
      contentType: type as Attachment['contentType'],
      sizeBytes: size,
      kind: residents ? 'OTHER' : ((body.kind as Attachment['kind']) ?? 'OTHER'),
      visibility: residents
        ? 'RESIDENT'
        : ((body.visibility as Attachment['visibility']) ?? 'INTERNAL'),
      uploadedBy: { userId: user.id, name: user.displayName },
      createdAt: now(),
      key,
      status: 'PENDING',
      removed: false,
    });
    return ok(
      {
        attachmentId: id,
        upload: {
          url: `${STORAGE_ORIGIN}/${key}`,
          method: 'PUT',
          headers: { 'Content-Type': type },
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      },
      201,
    );
  }

  private attachmentRoute(
    a: Attachment | undefined,
    action: string,
    method: string,
    user: { id: string },
    mayRemoveAny: boolean,
  ): Reply {
    if (!a || a.removed) return fail(404, 'NOT_FOUND');
    if (action === 'complete' && method === 'POST') {
      if (a.uploadedBy.userId !== user.id && !mayRemoveAny) return fail(403, 'NOT_UPLOADER');
      const bytes = this.objects.get(a.key);
      if (!bytes) return fail(409, 'UPLOAD_MISSING');
      if (bytes.length !== a.sizeBytes || sniff(bytes) !== a.contentType) {
        this.objects.delete(a.key);
        this.attachments = this.attachments.filter((x) => x !== a);
        return fail(422, 'FILE_REJECTED');
      }
      a.status = 'READY';
      return ok(this.attachmentView(a));
    }
    if (action === 'download' && method === 'GET') {
      if (a.status !== 'READY') return fail(404, 'NOT_FOUND');
      return ok({ url: `${STORAGE_ORIGIN}/${a.key}?download`, expiresAt: now() });
    }
    if (action === 'remove' && method === 'POST') {
      if (a.uploadedBy.userId !== user.id && !mayRemoveAny) return fail(403, 'NOT_UPLOADER');
      a.removed = true;
      this.objects.delete(a.key);
      return ok(undefined, 204);
    }
    return fail(404, 'NOT_FOUND');
  }

  // ------------------------------------------------------------------ residents

  handleUnit(c: UnitCtx): Reply {
    const { method, sub, body, user, unit, property } = c;
    const mine = (id: string) =>
      this.requests.find(
        (r) => r.id === id && r.unitId === unit.id && r.propertyId === property.id,
      );
    const detail = (r: Req) => ({
      request: this.view(r),
      events: this.events
        .filter((e) => e.requestId === r.id && e.visibility === 'RESIDENT')
        .map(stripTarget),
      attachments: this.filesOf({ requestId: r.id }, true),
    });
    if (sub === '' && method === 'GET') {
      return ok({
        data: this.requests
          .filter((r) => r.unitId === unit.id && r.propertyId === property.id)
          .reverse()
          .map((r) => this.view(r)),
      });
    }
    if (sub === '' && method === 'POST') {
      const created = this.createRequest(property.id, { unit, area: null }, body, user);
      return 'id' in created ? ok(detail(created), 201) : created;
    }
    const m = /^\/([^/]+)(?:\/(.*))?$/.exec(sub);
    const r = m ? mine(m[1] ?? '') : undefined;
    if (!m || !r) return fail(404, 'NOT_FOUND');
    const rest = m[2] ?? '';
    if (rest === '' && method === 'GET') return ok(detail(r));
    if (rest === 'notes' && method === 'POST') {
      const text = String(body.body ?? '').trim();
      if (!text) return fail(400, 'VALIDATION_FAILED');
      this.log({ requestId: r.id, workOrderId: null }, 'NOTE', 'RESIDENT', null, null, text, user);
      return ok(detail(r), 201);
    }
    if (rest === 'cancel' && method === 'POST') {
      if (r.submittedBy.userId !== user.id) return fail(403, 'NOT_REQUESTER');
      const refused = this.move(r, 'CANCELLED', String(body.reason ?? ''), user);
      return refused ?? ok(detail(r));
    }
    if ((rest === 'confirm' || rest === 'reopen') && method === 'POST') {
      if (!c.isResident) return fail(403, 'FORBIDDEN');
      if (rest === 'reopen' && r.status !== 'RESOLVED')
        return fail(409, 'INVALID_STATE_TRANSITION');
      const refused =
        rest === 'confirm'
          ? this.move(r, 'CLOSED', null, user)
          : this.move(r, 'ACCEPTED', String(body.reason ?? ''), user);
      return refused ?? ok(detail(r));
    }
    if (rest === 'attachments' && method === 'POST')
      return this.ask({ request: r, work: null }, body, user, true);
    const att = /^attachments\/([^/]+)\/(complete|download|remove)$/.exec(rest);
    if (att) {
      const a = this.attachments.find(
        (x) => x.id === att[1] && x.requestId === r.id && x.visibility === 'RESIDENT',
      );
      return this.attachmentRoute(a, att[2] ?? '', method, user, false);
    }
    return fail(404, 'NOT_FOUND');
  }

  // ------------------------------------------------------------------ staff and technicians

  handleProperty(c: Ctx): Reply | null {
    const { method, sub, body, url, property, user, permissions } = c;
    const can = (p: string) => permissions.includes(p);
    const pid = property.id;
    const requestOf = (id: string) =>
      this.requests.find((r) => r.id === id && r.propertyId === pid);
    const workOf = (id: string) => this.work.find((w) => w.id === id && w.propertyId === pid);

    // Technicians' own work.
    if (sub.startsWith('/my-work-orders')) {
      if (!can('property.maintenance.work')) return fail(403, 'FORBIDDEN');
      const rest = sub.slice('/my-work-orders'.length);
      if (rest === '' && method === 'GET') {
        const status = url.searchParams.get('status');
        return ok({
          data: this.work
            .filter((w) => w.propertyId === pid && w.assignedTo?.userId === user.id)
            .filter((w) => !status || w.status === status)
            .reverse()
            .map((w) => this.workView(w)),
        });
      }
      const m = /^\/([^/]+)(?:\/(.*))?$/.exec(rest);
      const w = m ? workOf(m[1] ?? '') : undefined;
      if (!m || !w || w.assignedTo?.userId !== user.id) return fail(404, 'NOT_FOUND');
      return this.workRoute(w, m[2] ?? '', method, body, user, property.currency, false);
    }

    if (!sub.startsWith('/maintenance')) return null;
    const rest = sub.slice('/maintenance'.length);
    const read = () => (can('property.maintenance.read') ? null : fail(403, 'FORBIDDEN'));
    const manage = () => (can('property.maintenance.manage') ? null : fail(403, 'FORBIDDEN'));

    if (rest === '/sla-targets') {
      if (method === 'GET') return read() ?? ok({ data: this.targets.get(pid) ?? [] });
      const denied = manage();
      if (denied) return denied;
      this.targets.set(pid, (body.targets as MaintenanceSlaTargetDto[]) ?? []);
      return ok({ data: this.targets.get(pid) });
    }
    if (rest === '/queue' && method === 'GET') {
      const denied = read();
      if (denied) return denied;
      const rank: Record<MaintenancePriority, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
      const rows = this.requests
        .filter(
          (r) => r.propertyId === pid && (r.status === 'SUBMITTED' || r.status === 'ACCEPTED'),
        )
        .map((r) => this.view(r))
        .sort((a, b) => {
          const oa = a.overdue.response || a.overdue.resolution ? 0 : 1;
          const ob = b.overdue.response || b.overdue.resolution ? 0 : 1;
          return (
            oa - ob || rank[a.priority] - rank[b.priority] || a.createdAt.localeCompare(b.createdAt)
          );
        });
      return ok({ data: rows });
    }
    if (rest === '/assignees' && method === 'GET') return manage() ?? ok({ data: c.assignees });
    if (rest === '/requests') {
      if (method === 'GET') {
        const status = url.searchParams.get('status');
        return (
          read() ??
          ok({
            data: this.requests
              .filter((r) => r.propertyId === pid && (!status || r.status === status))
              .reverse()
              .map((r) => this.view(r)),
          })
        );
      }
      const denied = manage();
      if (denied) return denied;
      const unit = c.units.find((u) => u.id === body.unitId) ?? null;
      const area = c.commonAreas.find((a) => a.id === body.commonAreaId) ?? null;
      if (!unit && !area) return fail(400, 'VALIDATION_FAILED');
      const created = this.createRequest(pid, { unit, area }, body, user);
      return 'id' in created ? ok(this.view(created), 201) : created;
    }
    const reqMatch = /^\/requests\/([^/]+)(?:\/(.*))?$/.exec(rest);
    if (reqMatch) {
      const r = requestOf(reqMatch[1] ?? '');
      if (!r) return fail(404, 'NOT_FOUND');
      const action = reqMatch[2] ?? '';
      if (action === '' && method === 'GET') {
        return (
          read() ??
          ok({
            request: this.view(r),
            workOrders: this.work.filter((w) => w.requestId === r.id).map((w) => this.workView(w)),
            events: this.events.filter((e) => e.requestId === r.id).map(stripTarget),
            attachments: this.filesOf({ requestId: r.id }, false),
          })
        );
      }
      const denied = manage();
      if (denied) return denied;
      const text = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
      if (action === '' && method === 'PATCH') {
        if (body.priority && body.priority !== r.priority) {
          this.log(
            { requestId: r.id, workOrderId: null },
            'PRIORITY_CHANGED',
            'RESIDENT',
            r.priority,
            String(body.priority),
            null,
            user,
          );
          r.priority = body.priority as MaintenancePriority;
          Object.assign(r, this.due(pid, r.priority, r.createdAt));
        }
        return ok(this.view(r));
      }
      if (action === 'accept') {
        if (r.status !== 'SUBMITTED') return fail(409, 'INVALID_STATE_TRANSITION');
        if (body.priority && body.priority !== r.priority) {
          r.priority = body.priority as MaintenancePriority;
          Object.assign(r, this.due(pid, r.priority, r.createdAt));
        }
        this.move(r, 'ACCEPTED', null, user);
        if (text('note'))
          this.log(
            { requestId: r.id, workOrderId: null },
            'NOTE',
            'RESIDENT',
            null,
            null,
            text('note'),
            user,
          );
        return ok(this.view(r));
      }
      if (action === 'reject' || action === 'cancel') {
        if (!text('reason')) return fail(400, 'VALIDATION_FAILED');
        if (
          action === 'cancel' &&
          this.work.some((w) => w.requestId === r.id && LIVE_WORK.includes(w.status))
        ) {
          return fail(409, 'INVALID_STATE_TRANSITION');
        }
        return (
          this.move(r, action === 'reject' ? 'REJECTED' : 'CANCELLED', text('reason'), user) ??
          ok(this.view(r))
        );
      }
      if (action === 'resolve') {
        const work = this.work.filter((w) => w.requestId === r.id);
        if (
          !work.some((w) => w.status === 'COMPLETED') ||
          work.some((w) => LIVE_WORK.includes(w.status))
        ) {
          return fail(409, 'INVALID_STATE_TRANSITION');
        }
        const refused = this.move(r, 'RESOLVED', null, user);
        if (!refused && text('note'))
          this.log(
            { requestId: r.id, workOrderId: null },
            'NOTE',
            'RESIDENT',
            null,
            null,
            text('note'),
            user,
          );
        return refused ?? ok(this.view(r));
      }
      if (action === 'close') return this.move(r, 'CLOSED', null, user) ?? ok(this.view(r));
      if (action === 'notes') {
        if (!text('body')) return fail(400, 'VALIDATION_FAILED');
        this.log(
          { requestId: r.id, workOrderId: null },
          'NOTE',
          (text('visibility') || 'INTERNAL') as 'RESIDENT' | 'INTERNAL',
          null,
          null,
          text('body'),
          user,
        );
        return ok({ data: this.events.filter((e) => e.requestId === r.id).map(stripTarget) }, 201);
      }
      if (action === 'attachments') return this.ask({ request: r, work: null }, body, user, false);
      return fail(404, 'NOT_FOUND');
    }
    if (rest === '/work-orders') {
      if (method === 'GET') {
        const status = url.searchParams.get('status');
        return (
          read() ??
          ok({
            data: this.work
              .filter((w) => w.propertyId === pid && (!status || w.status === status))
              .reverse()
              .map((w) => this.workView(w)),
          })
        );
      }
      const denied = manage();
      if (denied) return denied;
      const r = requestOf(String(body.requestId ?? ''));
      if (r?.status !== 'ACCEPTED') return fail(409, 'INVALID_STATE_TRANSITION');
      const assignee = body.assignedToUserId
        ? c.assignees.find((a) => a.userId === body.assignedToUserId)
        : null;
      if (body.assignedToUserId && !assignee) return fail(422, 'ASSIGNEE_NOT_ALLOWED');
      const w: Work = {
        id: randomUUID(),
        propertyId: pid,
        number: this.next(pid, 'WO'),
        requestId: r.id,
        requestNumber: r.number,
        unitId: r.unitId,
        unitNumber: r.unitNumber,
        commonAreaId: r.commonAreaId,
        commonAreaName: r.commonAreaName,
        category: r.category,
        priority: r.priority,
        title: r.title,
        description: r.description,
        status: assignee ? 'ASSIGNED' : 'OPEN',
        statusNote: null,
        assignedTo: assignee ? { userId: assignee.userId, name: assignee.name } : null,
        dueAt: null,
        startedAt: null,
        completedAt: null,
        createdAt: now(),
      };
      this.work.push(w);
      this.log(
        { requestId: r.id, workOrderId: w.id, workOrderNumber: w.number },
        'STATUS_CHANGED',
        'INTERNAL',
        null,
        w.status,
        null,
        user,
      );
      if (assignee)
        this.log(
          { requestId: r.id, workOrderId: w.id, workOrderNumber: w.number },
          'ASSIGNEE_CHANGED',
          'INTERNAL',
          null,
          assignee.userId,
          null,
          user,
        );
      return ok(this.workDetail(w, property.currency), 201);
    }
    const workMatch = /^\/work-orders\/([^/]+)(?:\/(.*))?$/.exec(rest);
    if (workMatch) {
      const w = workOf(workMatch[1] ?? '');
      if (!w) return fail(404, 'NOT_FOUND');
      const action = workMatch[2] ?? '';
      if (action === '' && method === 'GET')
        return read() ?? ok(this.workDetail(w, property.currency));
      const denied = manage();
      if (denied) return denied;
      if (action === 'assign') {
        const a = c.assignees.find((x) => x.userId === body.userId);
        if (!a) return fail(422, 'ASSIGNEE_NOT_ALLOWED');
        if (!LIVE_WORK.includes(w.status)) return fail(409, 'INVALID_STATE_TRANSITION');
        this.log(
          { requestId: w.requestId, workOrderId: w.id, workOrderNumber: w.number },
          'ASSIGNEE_CHANGED',
          'INTERNAL',
          w.assignedTo?.userId ?? null,
          a.userId,
          null,
          user,
        );
        w.assignedTo = { userId: a.userId, name: a.name };
        if (w.status === 'OPEN') w.status = 'ASSIGNED';
        return ok(this.workDetail(w, property.currency));
      }
      if (action === 'unassign') {
        if (w.status !== 'ASSIGNED') return fail(409, 'INVALID_STATE_TRANSITION');
        w.assignedTo = null;
        w.status = 'OPEN';
        return ok(this.workDetail(w, property.currency));
      }
      if (action === 'cancel') {
        if (!LIVE_WORK.includes(w.status)) return fail(409, 'INVALID_STATE_TRANSITION');
        w.status = 'CANCELLED';
        w.statusNote = String(body.reason ?? '');
        return ok(this.workDetail(w, property.currency));
      }
      return this.workRoute(w, action, method, body, user, property.currency, true);
    }
    const costVoid = /^\/costs\/([^/]+)\/void$/.exec(rest);
    if (costVoid && method === 'POST') {
      const denied = manage();
      if (denied) return denied;
      const cost = this.costs.find((x) => x.id === costVoid[1]);
      if (!cost) return fail(404, 'NOT_FOUND');
      if (cost.voidedAt) return fail(409, 'INVALID_STATE_TRANSITION');
      cost.voidedAt = now();
      cost.voidReason = String(body.reason ?? '');
      const w = workOf(cost.workOrderId);
      return w ? ok(this.workDetail(w, property.currency)) : fail(404, 'NOT_FOUND');
    }
    const att = /^\/attachments\/([^/]+)\/(complete|download|remove)$/.exec(rest);
    if (att) {
      const denied = att[2] === 'download' ? read() : manage();
      if (denied) return denied;
      return this.attachmentRoute(
        this.attachments.find((x) => x.id === att[1]),
        att[2] ?? '',
        method,
        user,
        true,
      );
    }
    return fail(404, 'NOT_FOUND');
  }

  /** Progress, notes, costs and files of one work order (assignee or manager). */
  private workRoute(
    w: Work,
    action: string,
    method: string,
    body: Record<string, unknown>,
    user: { id: string; displayName: string },
    currency: string,
    staff: boolean,
  ): Reply {
    const text = (k: string) => (typeof body[k] === 'string' ? (body[k] as string).trim() : '');
    const ref = { requestId: w.requestId, workOrderId: w.id, workOrderNumber: w.number };
    if (action === '' && method === 'GET') return ok(this.workDetail(w, currency));
    if (!staff && ['start', 'hold', 'complete'].includes(action) && method === 'POST') {
      const to: WorkOrderStatus =
        action === 'start' ? 'IN_PROGRESS' : action === 'hold' ? 'ON_HOLD' : 'COMPLETED';
      const allowed =
        (to === 'IN_PROGRESS' && (w.status === 'ASSIGNED' || w.status === 'ON_HOLD')) ||
        (to !== 'IN_PROGRESS' && w.status === 'IN_PROGRESS');
      if (!allowed) return fail(409, 'INVALID_STATE_TRANSITION');
      const note = to === 'IN_PROGRESS' ? null : text(to === 'ON_HOLD' ? 'reason' : 'note');
      if (to !== 'IN_PROGRESS' && !note) return fail(400, 'VALIDATION_FAILED');
      this.log(ref, 'STATUS_CHANGED', 'INTERNAL', w.status, to, note, user);
      w.status = to;
      w.statusNote = note;
      if (to === 'IN_PROGRESS' && !w.startedAt) w.startedAt = now();
      if (to === 'COMPLETED') w.completedAt = now();
      return ok(this.workDetail(w, currency));
    }
    if (action === 'notes' && method === 'POST') {
      if (!text('body')) return fail(400, 'VALIDATION_FAILED');
      this.log(
        ref,
        'NOTE',
        (text('visibility') || 'INTERNAL') as 'RESIDENT' | 'INTERNAL',
        null,
        null,
        text('body'),
        user,
      );
      return ok(this.workDetail(w, currency), 201);
    }
    if (action === 'costs' && method === 'POST') {
      const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text('amount'));
      if (!match || !text('description')) return fail(400, 'VALIDATION_FAILED');
      if (w.status === 'CANCELLED') return fail(409, 'INVALID_STATE_TRANSITION');
      const minor = BigInt(match[1] ?? '0') * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
      this.costs.push({
        id: randomUUID(),
        workOrderId: w.id,
        kind: text('kind') as WorkOrderCostDto['kind'],
        description: text('description'),
        amount: { amountMinor: minor.toString(), currency },
        recordedBy: { userId: user.id, name: user.displayName },
        createdAt: now(),
        voidedAt: null,
        voidReason: null,
      });
      return ok(this.workDetail(w, currency), 201);
    }
    if (action === 'attachments' && method === 'POST') {
      if (text('visibility') === 'RESIDENT' && !w.requestId) return fail(422, 'VALIDATION_FAILED');
      return this.ask({ request: null, work: w }, body, user, false);
    }
    const att = /^attachments\/([^/]+)\/(complete|download|remove)$/.exec(action);
    if (att) {
      return this.attachmentRoute(
        this.attachments.find((x) => x.id === att[1] && x.workOrderId === w.id),
        att[2] ?? '',
        method,
        user,
        false,
      );
    }
    return fail(404, 'NOT_FOUND');
  }
}

function stripTarget(
  e: MaintenanceEventDto & { requestId: string | null; workOrderId: string | null },
): MaintenanceEventDto {
  const { requestId: _r, workOrderId: _w, ...dto } = e;
  return dto;
}

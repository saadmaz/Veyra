import { randomUUID } from 'node:crypto';
import type {
  ChecklistDto,
  ChecklistResult,
  ChecklistTemplateDto,
  DepartmentDto,
  ShiftDto,
  VendorDocumentDto,
  VendorDto,
} from '@veyra/api-contracts';

/*
 * Vendors and staff operations for the fake API (Phase 9): the wire contracts and the main rules
 * (own shifts and checklists only, a handover to end a shift, every check answered before handing
 * in, nobody verifies their own checklist). The API's integration tests prove the rest.
 */

interface Reply {
  status: number;
  body?: unknown;
}

const fail = (status: number, code: string, message = code): Reply => ({
  status,
  body: { error: { code, message, details: [] } },
});
const ok = (body: unknown, status = 200): Reply => ({ status, body });
const now = () => new Date().toISOString();

interface User {
  id: string;
  displayName: string;
}

type Vendor = VendorDto & { organisationId: string; documents: VendorDocumentDto[] };
type Department = DepartmentDto & { propertyId: string };
type Shift = ShiftDto & { propertyId: string };
type Template = ChecklistTemplateDto & { propertyId: string };
type Checklist = ChecklistDto & { propertyId: string };

export class FakeOps {
  vendors: Vendor[] = [];
  departments: Department[] = [];
  shifts: Shift[] = [];
  templates: Template[] = [];
  checklists: Checklist[] = [];

  private vendorView(v: Vendor): VendorDto {
    const { organisationId: _o, documents, ...rest } = v;
    const live = documents.filter((d) => !d.voidedAt);
    const today = now().slice(0, 10);
    const compliance =
      live.length === 0
        ? 'NO_DOCUMENTS'
        : live.some((d) => d.expiresOn && d.expiresOn < today)
          ? 'EXPIRED'
          : 'OK';
    return { ...rest, compliance };
  }

  handleVendors(c: {
    method: string;
    sub: string;
    body: Record<string, unknown>;
    organisationId: string;
    user: User;
    can: (p: string) => boolean;
  }): Reply | null {
    const { method, sub, body, organisationId, user, can } = c;
    if (!sub.startsWith('/vendors')) return null;
    if (!can('organisation.vendor.read')) return fail(403, 'FORBIDDEN');
    const detail = (v: Vendor) => ({ vendor: this.vendorView(v), documents: v.documents });
    if (sub === '/vendors' && method === 'GET') {
      return ok({
        data: this.vendors
          .filter((v) => v.organisationId === organisationId)
          .map((v) => this.vendorView(v)),
      });
    }
    if (!can('organisation.vendor.manage') && method !== 'GET') return fail(403, 'FORBIDDEN');
    if (sub === '/vendors' && method === 'POST') {
      const v: Vendor = {
        id: randomUUID(),
        organisationId,
        name: String(body.name),
        categories: [],
        contactName: (body.contactName as string | null) ?? null,
        email: (body.email as string | null) ?? null,
        phone: (body.phone as string | null) ?? null,
        taxReference: null,
        notes: null,
        status: 'ACTIVE',
        statusNote: null,
        compliance: 'NO_DOCUMENTS',
        archivedAt: null,
        createdAt: now(),
        documents: [],
      };
      this.vendors.push(v);
      return ok(detail(v), 201);
    }
    const m = /^\/vendors\/([^/]+)(\/.*)?$/.exec(sub);
    const v = m
      ? this.vendors.find((x) => x.id === m[1] && x.organisationId === organisationId)
      : undefined;
    if (!m || !v) return fail(404, 'NOT_FOUND');
    const rest = m[2] ?? '';
    if (rest === '' && method === 'GET') return ok(detail(v));
    if (rest === '/documents' && method === 'POST') {
      v.documents.unshift({
        id: randomUUID(),
        kind: body.kind as VendorDocumentDto['kind'],
        title: String(body.title),
        reference: (body.reference as string | null) ?? null,
        validFrom: null,
        expiresOn: (body.expiresOn as string | null) ?? null,
        expired: false,
        addedBy: user.displayName,
        createdAt: now(),
        voidedAt: null,
        voidReason: null,
      });
      return ok(detail(v), 201);
    }
    if (rest === '/suspend' && method === 'POST') {
      v.status = 'SUSPENDED';
      v.statusNote = String(body.reason);
      return ok(detail(v));
    }
    if (rest === '/reactivate' && method === 'POST') {
      v.status = 'ACTIVE';
      v.statusNote = null;
      return ok(detail(v));
    }
    return fail(404, 'NOT_FOUND');
  }

  handleStaff(c: {
    method: string;
    sub: string;
    body: Record<string, unknown>;
    propertyId: string;
    user: User;
    permissions: string[];
    people: User[];
  }): Reply | null {
    const { method, sub, body, propertyId, user, permissions, people } = c;
    const can = (p: string) => permissions.includes(p);
    const nameOf = (id: string) => people.find((p) => p.id === id)?.displayName ?? '';

    if (sub.startsWith('/my-shifts')) {
      if (!can('property.staff.work')) return fail(403, 'FORBIDDEN');
      const mine = this.shifts.filter(
        (s) => s.propertyId === propertyId && s.person.userId === user.id,
      );
      if (sub === '/my-shifts' && method === 'GET') return ok({ data: mine });
      const m = /^\/my-shifts\/([^/]+)(\/.*)?$/.exec(sub);
      const s = m ? mine.find((x) => x.id === m[1]) : undefined;
      if (!m || !s) return fail(404, 'NOT_FOUND');
      const view = () => {
        const previous = this.shifts
          .filter(
            (x) => x.department.id === s.department.id && x.status === 'ENDED' && x.id !== s.id,
          )
          .sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''))[0];
        return {
          shift: s,
          previousHandover: previous
            ? {
                note: previous.handoverNote ?? '',
                by: previous.person.name,
                endedAt: previous.endedAt ?? '',
              }
            : null,
        };
      };
      if ((m[2] ?? '') === '' && method === 'GET') return ok(view());
      if (m[2] === '/start' && method === 'POST') {
        if (s.status !== 'SCHEDULED') return fail(409, 'INVALID_STATE_TRANSITION');
        s.status = 'STARTED';
        s.startedAt = now();
        return ok(view());
      }
      if (m[2] === '/end' && method === 'POST') {
        if (s.status !== 'STARTED') return fail(409, 'INVALID_STATE_TRANSITION');
        if (!body.handoverNote) return fail(400, 'VALIDATION_FAILED');
        s.status = 'ENDED';
        s.endedAt = now();
        s.handoverNote = String(body.handoverNote);
        return ok(view());
      }
      return fail(404, 'NOT_FOUND');
    }

    if (sub.startsWith('/my-checklists')) {
      if (!can('property.staff.work')) return fail(403, 'FORBIDDEN');
      const mine = this.checklists.filter(
        (x) => x.propertyId === propertyId && x.assignedTo.userId === user.id,
      );
      if (sub === '/my-checklists' && method === 'GET') return ok({ data: mine });
      const m = /^\/my-checklists\/([^/]+)(\/.*)?$/.exec(sub);
      const run = m ? mine.find((x) => x.id === m[1]) : undefined;
      if (!m || !run) return fail(404, 'NOT_FOUND');
      const item = /^\/items\/(\d+)$/.exec(m[2] ?? '');
      if (item && method === 'PUT') {
        if (run.status !== 'OPEN') return fail(409, 'INVALID_STATE_TRANSITION');
        const i = run.items.find((x) => x.position === Number(item[1]));
        if (!i) return fail(404, 'NOT_FOUND');
        if (body.result === 'FAIL' && !body.note)
          return fail(400, 'VALIDATION_FAILED', 'Say what was wrong');
        i.result = body.result as ChecklistResult;
        i.note = (body.note as string | undefined) ?? null;
        i.answeredAt = now();
        run.answered = run.items.filter((x) => x.result).length;
        run.failures = run.items.filter((x) => x.result === 'FAIL').length;
        return ok(run);
      }
      if (m[2] === '/submit' && method === 'POST') {
        if (run.answered < run.items.length)
          return fail(422, 'INCOMPLETE', 'Answer every check before submitting');
        run.status = 'SUBMITTED';
        run.submittedAt = now();
        run.statusNote = null;
        return ok(run);
      }
      return fail(404, 'NOT_FOUND');
    }

    if (!sub.startsWith('/staff')) return null;
    if (!can('property.staff.read')) return fail(403, 'FORBIDDEN');
    const manage = can('property.staff.manage');
    const rest = sub.slice('/staff'.length);
    if (rest === '/departments' && method === 'GET') {
      return ok({ data: this.departments.filter((d) => d.propertyId === propertyId) });
    }
    if (rest === '/people' && method === 'GET') {
      return ok({ data: people.map((p) => ({ userId: p.id, name: p.displayName })) });
    }
    if (rest === '/checklist-templates' && method === 'GET') {
      return ok({ data: this.templates.filter((t) => t.propertyId === propertyId) });
    }
    if (rest.startsWith('/checklists') && method === 'GET') {
      return ok({
        data: this.checklists.filter(
          (x) => x.propertyId === propertyId && x.status === 'SUBMITTED',
        ),
      });
    }
    if (rest.startsWith('/shifts') && method === 'GET') {
      return ok({ data: this.shifts.filter((s) => s.propertyId === propertyId) });
    }
    if (!manage) return fail(403, 'FORBIDDEN');
    if (rest === '/departments' && method === 'POST') {
      const d: Department = {
        id: randomUUID(),
        propertyId,
        name: String(body.name),
        status: 'ACTIVE',
        archivedAt: null,
        createdAt: now(),
        members: [],
      };
      this.departments.push(d);
      return ok(d, 201);
    }
    const member = /^\/departments\/([^/]+)\/members$/.exec(rest);
    if (member && method === 'POST') {
      const d = this.departments.find((x) => x.id === member[1]);
      if (!d) return fail(404, 'NOT_FOUND');
      const userId = String(body.userId);
      d.members.push({ userId, name: nameOf(userId), addedAt: now() });
      return ok(d, 201);
    }
    if (rest === '/shifts' && method === 'POST') {
      const d = this.departments.find((x) => x.id === body.departmentId);
      if (!d) return fail(404, 'NOT_FOUND');
      const userId = String(body.userId);
      const s: Shift = {
        id: randomUUID(),
        propertyId,
        department: { id: d.id, name: d.name },
        person: { userId, name: nameOf(userId) },
        startsAt: String(body.startsAt),
        endsAt: String(body.endsAt),
        status: 'SCHEDULED',
        startedAt: null,
        endedAt: null,
        handoverNote: null,
        cancelReason: null,
        createdAt: now(),
      };
      this.shifts.push(s);
      return ok(s, 201);
    }
    if (rest === '/checklist-templates' && method === 'POST') {
      const t: Template = {
        id: randomUUID(),
        propertyId,
        title: String(body.title),
        department: null,
        items: body.items as string[],
        status: 'ACTIVE',
        createdAt: now(),
      };
      this.templates.push(t);
      return ok(t, 201);
    }
    if (rest === '/checklists' && method === 'POST') {
      const t = this.templates.find((x) => x.id === body.templateId);
      if (!t) return fail(404, 'NOT_FOUND');
      const userId = String(body.assignedToUserId);
      const run: Checklist = {
        id: randomUUID(),
        propertyId,
        templateId: t.id,
        title: t.title,
        assignedTo: { userId, name: nameOf(userId) },
        shiftId: null,
        dueOn: String(body.dueOn),
        status: 'OPEN',
        submittedAt: null,
        verifiedAt: null,
        verifiedBy: null,
        statusNote: null,
        failures: 0,
        answered: 0,
        createdAt: now(),
        items: t.items.map((text, i) => ({
          position: i + 1,
          text,
          result: null,
          note: null,
          answeredAt: null,
        })),
      };
      this.checklists.push(run);
      return ok(run, 201);
    }
    const action = /^\/checklists\/([^/]+)\/(verify|return)$/.exec(rest);
    if (action && method === 'POST') {
      const run = this.checklists.find((x) => x.id === action[1]);
      if (!run) return fail(404, 'NOT_FOUND');
      if (run.status !== 'SUBMITTED') return fail(409, 'INVALID_STATE_TRANSITION');
      if (action[2] === 'verify') {
        if (run.assignedTo.userId === user.id) return fail(403, 'OWN_CHECKLIST');
        run.status = 'VERIFIED';
        run.verifiedAt = now();
        run.verifiedBy = user.displayName;
      } else {
        run.status = 'OPEN';
        run.submittedAt = null;
        run.statusNote = String(body.reason);
      }
      return ok(run);
    }
    return fail(404, 'NOT_FOUND');
  }
}
